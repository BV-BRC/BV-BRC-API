# PLAN — Server→browser download notifications via SSE (start / complete + result count)

**Status:** proposal, for vetting against the website download client
**Owner:** Data API (client contribution is small; see §Client)
**Related:** `PLAN_CROSS_COLLECTION_DOWNLOAD.md` (shares the result-count signal),
`Docs/GENBANK_DOWNLOAD_PERFORMANCE.md` (streaming/backpressure), `Docs/VALKEY_CACHING_PLAN.md`
(Redis/Valkey pub/sub substrate), `../bvbrc_website/public/js/p3/util/DownloadExecutor.js`,
`../bvbrc_website/public/js/p3/widget/copilot/CopilotApi.js` (existing fetch-SSE reader pattern).

---

## Problem

Downloads in the website are **hidden-form POSTs** (`DownloadExecutor.submitDownloadForm`): the browser
hands the response straight to the native download manager, so **JavaScript cannot read the status line,
headers, or body** of a download. Consequences:

- A zero-match download returns `200` + a 0-byte file with no way for the client to warn the user
  (the original BUG 2 symptom, and the reason the cross-collection plan's `X-Result-Count` header is
  unreadable by the client).
- Long synchronous downloads (Solr cursor export + serialization; seconds-to-minutes at genus scale,
  and worse for the cross-collection prefetch case) give no start/finish feedback.

We want lightweight, precise **status reporting** — decoupled from the (deliberately native, zero-JS,
resumable, memory-ceiling-free) file transfer. Scope for v1: **two events per download — `start` and
`complete` (with result count and filename)** — surfaced as a toast. No byte-progress, no packaging
granularity.

## Non-goals (v1)

- Byte-level transfer progress (leave the transfer on the native manager).
- Bundle/packaging "N of M files" progress — that is the separate `bundleConfig`/`jobId` side channel
  already stubbed in `DownloadExecutor.executeBundleDownload`; it can later share this event bus + toast.
- Replacing the download transport. The form POST stays; this is a **side channel**.

---

## Production topology (the constraints that shape this)

`browser → Cloudflare → nginx → data API`, **same hostname, same origin** (the data API is mounted at
`/api` or similar on the site host; the absolute `p3.theseed.org` value in the website `config.js` is a
dev fallback). Therefore:

- **No CORS.** Same-origin `/api/download-events`. Cookies flow by default; no preflight, no
  `Access-Control-*` handling.
- **Express is NOT in the production path** (the website's `express-http-proxy` is dev-only). Nothing to
  tune there.
- **Two buffering hops to control:** nginx (origin-side, we own it) and **Cloudflare** (edge, config-only,
  the one we can't instrument from the app). See §Edge/proxy requirements — these are non-negotiable.

## Auth

Native `EventSource` **cannot set an `Authorization` header**, and website auth is a JS-held bearer token
(`window.App.authorizationToken`), not an HttpOnly cookie. So the client uses a **fetch-based SSE reader**
(read `response.body` as a stream), exactly as `CopilotApi.js` already does:

```js
fetch('/api/download-events', {
  headers: { 'Authorization': window.App.authorizationToken || '', 'Accept': 'text/event-stream',
             'Cache-Control': 'no-cache' },
  signal: abort.signal
}).then(r => r.body.getReader() … )   // parse event:/data:/':' heartbeat frames
```

The token identifies the user; the endpoint streams **only that user's events**. (If a same-origin
session cookie the API honors ever exists, native `EventSource` becomes an option — not assumed here.)

---

## Architecture

The download (form POST) and the SSE stream are two independent requests. They are correlated by a
**client-minted download id** echoed on both legs.

```
        browser                                   Cloudflare → nginx → data API (pm2 cluster)
   ┌────────────────┐
   │ 1. dlId = uuid │
   │ 2. open SSE ───┼── GET /api/download-events (fetch, token) ──► held open; subscribes user channel
   │    (once/tab)  │
   │ 3. submit form │
   │  POST /api/…/  ┼── ?http_download=true … &http_download_id=dlId ──► worker A: run + stream file
   │                │◄════════════ file bytes (native download manager) ════════════════════
   │                │                                       worker A: PUBLISH user:<uid> {dlId,start}
   │                │                                       …then at end: {dlId,complete,count,filename}
   │ 4. SSE frame ◄─┼──────── event: download {dlId,phase,count,filename} ◄── SSE worker (B) relays ──
   │  match dlId →  │
   │  /Notification │
   │  → Toaster     │
   └────────────────┘
```

**Cross-worker fan-out is required.** The API runs pm2 **cluster mode** (`default_pm2_config.js:
exec_mode: "cluster"`), so the download (worker A) and the SSE connection (worker B) are usually
different processes. In-process `EventEmitter` will not work. Use **Redis/Valkey pub/sub** — `redis` is
already a dependency (`package.json`) with an active client (`Docs/VALKEY_CACHING_PLAN.md`). Channel per
user: `dl-events:<user>`. The SSE handler `SUBSCRIBE`s its user's channel; the download handler
`PUBLISH`es start/complete to it. No new infrastructure.

### Server components

1. **`GET /api/download-events` (SSE endpoint).**
   - Auth: resolve user from the `Authorization` token (same as any API route). Reject unauth → 401.
   - Immediately write status 200 + SSE headers + an initial `: connected\n\n` (flush before any slow
     work — critical for Cloudflare's 100s time-to-first-byte rule).
   - `SUBSCRIBE dl-events:<user>` on a dedicated Redis connection; relay each message as an
     `event: download\ndata: <json>\n\n` frame.
   - **Heartbeat:** write `: ping\n\n` every ~20s (keeps Cloudflare/NAT from reaping the idle stream).
   - Clean up (unsubscribe, clear heartbeat) on `req.close`/`res.destroyed`.
   - Bound concurrent streams per user (e.g. reject/replace beyond N) so a tab-leak can't pin
     connections/Redis subscribers.

2. **Download-handler hook (emit lifecycle).** Where a download request carries `http_download_id`:
   - On accept: `PUBLISH dl-events:<user> {dlId, phase:'start', ts}`.
   - On stream end: `PUBLISH … {dlId, phase:'complete', count:<X-Result-Count>, filename, ts}`.
     The count is already computed for the response headers (and, for cross-collection, is
     `X-Result-Count` from `PLAN_CROSS_COLLECTION_DOWNLOAD.md`) — this just also writes it to the bus.
   - On error/abort: `{dlId, phase:'error', message}` (best-effort).
   - Emission is **fire-and-forget** — a Redis publish failure must never affect the download itself.

### Client components (website)

- **`DownloadExecutor.submitDownloadForm`:** mint `dlId`, add hidden input / query param
  `http_download_id=<dlId>`, register `dlId` in a `pending` map before `form.submit()`.
- **One shared SSE reader per tab** (lazy-opened on first download), fetch-based per the auth section,
  modeled on `CopilotApi.js`. On a `download` frame whose `dlId` is in `pending`:
  - `phase:'complete'` → `Topic.publish('/Notification', { message: count===0
      ? 'Download finished: no records matched' : 'Download ready: '+count+' records ('+filename+')',
      type: count===0 ? 'warning' : 'message' })` — reuses the existing `Toaster`
      (`p3app.js:527`, `messageTopic:'/Notification'`). No new UI.
  - dedupe by `dlId+phase` (SSE auto-reconnect can redeliver).
- **Graceful degradation:** if the SSE reader never connects or dies, the download **still works** — it
  is an independent native POST. The only loss is the toast. No download-path timeout depends on SSE.

---

## Edge / proxy requirements (the de-risking that matters)

SSE dies quietly if any hop buffers or times out. Required settings:

**Origin (data API response on `/api/download-events`):**
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`  ← `no-transform` tells Cloudflare not to compress/optimize
- `Connection: keep-alive`, `X-Accel-Buffering: no`  ← disables **nginx** proxy buffering for this route
- Flush headers + `: connected` immediately; heartbeat every ~20s; no gzip on this route.

**nginx (the `/api/download-events` location):** `proxy_buffering off;` `proxy_cache off;`
`proxy_read_timeout` well above the heartbeat interval (e.g. 3600s); HTTP/1.1 keepalive to upstream.

**Cloudflare (edge — config only, cannot be set from the app):** CF proxies `text/event-stream` as a
stream and does not whole-response buffer by default; the `no-transform` header + immediate first byte +
heartbeat cover the known failure modes (compression buffering, 524 time-to-first-byte, idle reap).
Confirm no Page/Config Rule enables buffering or compression on `/api/download-events`.

### Phase 0 — MANDATORY edge validation gate (do this BEFORE building the backend)

Cloudflare is the hop we cannot instrument. Prove SSE survives the real edge before committing:

```
# against a throwaway endpoint that emits a frame every 2s through the PRODUCTION hostname:
curl -N https://<prod-host>/api/download-events-probe
```

- Frames arrive **incrementally** (one every 2s) → edge is SSE-safe → build this plan.
- Frames arrive **in a clump at connection close** → something buffers; chase hop by hop (origin
  `no-transform` → nginx `proxy_buffering off` → CF rule). If CF cannot be made to cooperate → **abandon
  SSE** and fall back to the cheap alternative below.

## Cheaper fallback if SSE is not viable on the edge

For the **empty-result warning specifically** (the highest-value slice), a client **pre-flight count**
needs none of this: before submitting the download form, issue a normal readable XHR
`GET /api/<collection>/?<query>&limit(0)` and read `numFound` from `Content-Range`. Measured ~0.5–0.75s
vs ~3–5s for the download — cheap, same-origin, immune to all buffering. Accurate for
**same-collection** downloads; for **cross-collection** it only catches "source matched nothing" (not
join-shortfall zero results — see `PLAN_CROSS_COLLECTION_DOWNLOAD.md` §X-Source-Rows>X-Resolved). Ship
this regardless as the empty-download guard; SSE adds live start/complete on top when the edge allows.

---

## Phasing

1. **Phase 0 — edge validation** (`curl -N` probe through Cloudflare). Gate. Half-day. If it fails, stop
   and ship the pre-flight count instead.
2. **SSE endpoint + Redis pub/sub** (`/api/download-events`, per-user channel, heartbeat, auth, cleanup,
   per-user connection cap). Backend-only, testable with `curl -N`.
3. **Download-handler emission** (`start`/`complete{count,filename}` publish; fire-and-forget). Reuses
   the count already computed for response headers.
4. **Client wiring** (`http_download_id` on the form, shared fetch-SSE reader, `/Notification` toast,
   dedupe, graceful degrade). Modeled on `CopilotApi.js`.
5. **Empty-download UX** — `count===0` warning toast (this is the payoff; also delivered by the fallback
   count if SSE is skipped).
6. **Generalize** — bundle path (`jobId`) can later publish packaging progress to the same channel/toast.

## Edge cases / non-negotiables

- **Per-user scoping (IDOR).** The SSE stream is filtered to the authenticated user; `dlId` only
  correlates *within* that user's stream. A `dlId` alone must never let another session read events.
- **Fire-and-forget emission.** A Redis/publish failure must not affect the download. Downloads are the
  product; notifications are enhancement.
- **Reconnect/idempotency.** Tolerate SSE auto-reconnect + `Last-Event-ID`; client dedupes `dlId+phase`.
- **Connection budget.** One shared stream per tab; cap streams/user server-side; always clean up on
  disconnect (Redis subscriber + heartbeat timer leak otherwise).
- **No dependency inversion.** Nothing in the download path may block on, wait for, or time out against
  the SSE side channel.

## Open questions

1. Is there a same-origin session cookie the `/api` route already honors? If so, native `EventSource`
   (no fetch-reader) becomes viable — simpler client. Assumed **no** (token-only) until confirmed.
2. Redis/Valkey pub/sub sizing: subscriber connection per SSE stream vs a shared subscriber demuxing by
   channel. Prefer a shared subscriber keyed by user to bound connection count under many tabs.
3. Should `start` also toast ("Preparing download…"), or only `complete`? Leaning complete-only for v1 to
   avoid toast spam on fast downloads; `start` still published for future use.
