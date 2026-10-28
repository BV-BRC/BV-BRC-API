# PLAN: two-phase bulk download via a non-Cloudflare host

**Status:** proposal. Not implemented.
**Written:** 2026-10-28.
**Audience:** network/infrastructure admins first — §2 and §7 are the decisions that need
their input; the rest is API-side work that follows from those answers.

---

## 1. The problem, measured

Cloudflare terminates a response that goes quiet for too long, **even after the response
has started**. Measured against alpha through the real proxy chain (`stall-test`,
2026-10-28):

| silence between bytes | result |
|---|---|
| 60 s | 200, complete |
| 100 s | 200, complete |
| 120 s | 200, complete |
| **150 s** | **connection cut at 127 s, body truncated** |
| 30 s heartbeat × 6 (3 min total) | 200, complete — all ticks delivered |

So the budget is **between 120 and 150 seconds of silence**, and it **resets on every
byte**. It is not a time-to-first-byte limit and not a total-duration limit.

Two properties of that make it nasty:

- **The failure looks like success.** The 150 s case returned **HTTP 200** with a
  truncated body, not a 524 — the status line goes out with the first chunk, so once any
  byte is written Cloudflare cannot change the status. Same silent-truncation class as the
  `sort()`-less stream and the mid-stream shard failure already recorded in `CLAUDE.md`.
- **The origin is not the constraint.** `alpha.bv-brc.org.conf` sets
  `proxy_read_timeout 1800s` and `proxy_buffering off` on `/api/`; `nginx.conf` sets
  `proxy_read_timeout 3600`. nginx would wait 30 minutes and does not buffer. Confirmed
  the cut is Cloudflare's: the body is literally `error code: 524`, `server: cloudflare`,
  and five 1-second ticks arrive one second apart through the full chain.

### Why this bites now

Broad-taxon downloads resolve a cross-collection join by walking the genome set in slices
(`lib/BatchedJoinStream.js`). When the query also carries a selective filter — the real
example is `annotation:"PATRIC"` over Viruses, 14.9 M genomes — most slices match nothing,
so the stream legitimately produces no rows for minutes at a time. Observed:

```
limit(3000)   -> 200, ttfb  3.6s
limit(5000)   -> 200, ttfb  4.4s
limit(10000)  -> 524, silent for 125s
limit(2500000)-> 524, silent for 125s        <- the user's actual query
```

Nothing is broken. The pipeline is working and quiet, and Cloudflare kills it.

### Why the obvious fix does not work

A keepalive byte. **There is no byte that is harmless in every serializer this path
feeds.** A blank line is tolerable in CSV and FASTA; inside `media/json.js`'s single JSON
array — the default content type — it is a syntax error. A per-serializer keepalive would
rescue two formats and corrupt the rest.

---

## 2. Proposal, and what it asks of infrastructure

Split a bulk download in two:

```
  PHASE 1   POST https://www.bv-brc.org/api/<collection>/?http_download=true...
            (through Cloudflare, as today)
            -> validate, size the query, mint a token
            -> 302 to the download host

  PHASE 2   GET  https://download.bv-brc.org/dl/<token>
            (NOT through Cloudflare)
            -> stream for as long as it takes
```

Phase 1 stays small and fast, so Cloudflare never sees a long response. Phase 2 has no
edge timeout, so the 30-minute Viruses download that nginx would already tolerate actually
completes.

### What we need from infrastructure

1. **A hostname that bypasses Cloudflare.** Orange-cloud off / DNS-only, or a separate
   name pointed straight at the origin. Cloudflare's protections are per-hostname, so this
   does **not** require a separate machine — a second nginx `server` block on the same host
   is sufficient and is the simplest option.
2. **TLS for that hostname.** The existing setup uses Let's Encrypt
   (`/etc/letsencrypt/live/alpha.bv-brc.org/`); a new name needs its own certificate.
   Without CF in front, cert renewal must work directly against the origin.
3. **A view on losing CF's protections** for that hostname — DDoS absorption, bot
   filtering, WAF, rate limiting. §7 covers what we intend to do instead, and that is the
   part most worth their review.
4. **Confirmation of Redis reachability** (§4): if phase 2 runs on the same host, none
   needed; if on a different host, Redis must be reachable and authenticated.

### What this is not

Not a CDN change, not a new machine (unless you want one), and not a change to how the
website issues downloads beyond following a redirect.

---

## 3. Why a redirect rather than always using the download host

The website could point downloads at the non-CF host directly and skip phase 1. We should
not, for two reasons:

- **The validation is worth doing behind Cloudflare.** Phase 1 already exists in all but
  name: `lib/joinResolver.js` counts the genome set before anything streams, which is what
  produces today's `join_too_broad` 400 with `genomeCount`, `limit`, and `taxonId`. Doing
  that check at the protected edge means an abusive or malformed request is refused
  without the unprotected host ever seeing it.
- **It keeps the unprotected surface tiny.** Phase 2 accepts exactly one shape: a token.
  No RQL, no collection name, no serializer parameters. Anything else is a 404. That is a
  much smaller thing to defend than a general query API.

---

## 4. Token design

**Opaque random token in Redis**, not a signed JWT. Reasons, in order of weight:

- **Revocable and single-use.** Delete the key when the download starts and the URL is
  spent. A signed token is valid until it expires, and phase-2 URLs will land in browser
  history, proxy logs, and the occasional support ticket.
- **No key management.** No signing secret to share between hosts or rotate.
- **No size limit on the payload.** The user's real query was ~2.5 M rows of RQL with
  nested clauses; stuffing that into a URL-safe JWT is unpleasant, and storing it is free.

### Shape

```
key    dlt:<32 random url-safe bytes>          (prefix matters -- see below)
ttl    300 seconds
value  JSON {
         collection:   "genome_feature",
         rql:          "<the original RQL, verbatim>",
         accept:       "application/protein+fasta",
         fastaParams:  { ... },        // http_fasta_* as captured by http-params.js
         filterParams: { ... },        // http_filter_* likewise
         user:         "olson@patricbrc.org" | null,
         createdAt:    1761690000,
         clientIp:     "x.x.x.x"
       }
```

Four points that are load-bearing:

**Store the IDENTITY, re-derive the PERMISSIONS.** Do not cache the resolved
`permissionFq`. A user whose access changed between phases would otherwise get the stale
scope. Phase 2 calls `buildPermissionFq({collection, user, publicFree})` exactly as
`DecorateQuery` does — one source of truth, per `lib/permissionFilter.js`.

**Prefix the key.** `config.js` has `redis.db: 2` with `prefix: ''`, shared with apicache,
whose keys are raw URLs. `dlt:` avoids collisions and makes the keyspace inspectable.

**Short TTL.** 300 s is ample for a browser to follow a redirect and is short enough that
a leaked URL is near-worthless. The TTL governs *starting* the download, not its duration —
once streaming begins the token is gone and the stream runs as long as it needs.

**The redis client is 2.x and callback-style.** `CLAUDE.md` lists the v4 upgrade as a real
migration, not a version bump. New code should follow the callback pattern already in
`rpc/proteinFamily.js`, not introduce a second client style.

---

## 5. Phase 1 — mint and redirect

Where: a small middleware after `JoinResolution` in `routes/dataType.js`, active only when
`req.isDownload` and the two-phase feature is enabled.

```
if (!twoPhaseEnabled() || !req.isDownload)         -> unchanged behaviour
if (the query is cheap)                             -> stream inline, as today
if (the query is over the two-phase threshold)      -> mint a token, 302
if (the query is refused by joinResolver)           -> 400 join_too_broad, as today
```

**Which downloads go two-phase?** Simplest defensible rule: any download whose join
exceeds `joinResolution.rewriteMaxGenomes`, since that is already the line between "inline
`{!terms}`" and "needs the slice walk". Small downloads keep working exactly as they do
now and never see a redirect.

**302 vs 307.** Must be **302 to a GET**. A hidden-form POST — which is how the website
issues downloads — cannot have its body replayed cross-origin, so the token has to carry
everything. That is already the design.

**CORS.** The redirect crosses origins. `util/corsOptions.js` currently exposes
`Retry-After`, `Content-Range` and friends; the download host needs its own CORS policy,
and a browser following a 302 to a different origin for a file download generally does not
need CORS at all — but this must be verified against the website's actual download
mechanism (hidden form vs `fetch` vs `window.location`), because the three behave
differently.

---

## 6. Phase 2 — stream

A separate lightweight express app, or a dedicated route mounted on a second nginx vhost:

```
GET /dl/:token
  1. GETDEL dlt:<token>            (single use; 404 if absent or expired)
  2. rebuild req-shaped context from the stored value
  3. recompute the permission fq from `user`
  4. run the existing pipeline: RQLQueryParser -> ... -> BatchedJoinStream -> media
  5. stream until done
```

Nothing new in the streaming path — it is the same middleware chain and the same
serializers. The only novelty is where the request parameters come from.

**nginx for the download vhost** should mirror `/api/`:

```nginx
proxy_read_timeout 1800s;
proxy_buffering off;
proxy_ignore_client_abort on;
proxy_max_temp_file_size 0;
```

Those are already proven on `/api/` and are what make a 30-minute stream possible.

---

## 7. What we lose with Cloudflare off, and what replaces it

This is the section for the network admins.

| CF provides | on the download host instead |
|---|---|
| bot filtering | the token: no valid token, no response. Tokens are single-use, 5-minute TTL, and only mintable through the protected phase-1 endpoint |
| rate limiting | needs explicit provision — see below |
| DDoS absorption | **genuinely lost.** The host is directly exposed |
| WAF | surface is one route taking one opaque token; there is no query to inject into |
| TLS termination | Let's Encrypt direct to origin |

**Rate limiting is the gap that needs a decision.** The existing admission control
(`lib/SolrAdmissionControl.js`) is per-worker and counts concurrency, not request rate, and
phase 2 would be a different pool. Options, not mutually exclusive:

- nginx `limit_req` / `limit_conn` on the download vhost, keyed by IP;
- cap concurrent active downloads in the phase-2 app, rejecting with 503 + `Retry-After`;
- bind the token to the requesting IP at mint time (stored as `clientIp`) and reject a
  mismatch at phase 2. Note this breaks for users behind rotating egress IPs and for
  mobile networks — worth discussing whether the trade is acceptable.

**Exposure is bounded by design.** Even with no rate limiting, an attacker without a token
gets a 404 from a route that does nothing else. The realistic abuse is someone who *can*
mint tokens (any user) minting many and running concurrent downloads — which is a
resource-exhaustion concern, addressed by the concurrency cap, not a security hole.

---

## 8. What this makes unnecessary

Worth stating, because there is in-flight work it would supersede:

- **The stall guard** currently uncommitted in `lib/BatchedJoinStream.js` (ends the walk
  after 90 s with no rows rather than being cut mid-record). Still worth keeping as a
  safety net — a walk finding nothing for 90 s is probably wrong — but it stops being
  load-bearing.
- **The partial-download logging** in `middleware/JoinResolution.js`, same status.
- **A time-based flush in `SequenceJoinStream`** (prototyped, not committed, test harness
  was wrong). Two-phase removes its reason to exist; drop it.
- **Much of `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md`'s urgency.** That plan exists partly
  because a hidden-form POST cannot read response headers and partly because downloads can
  fail invisibly. Two-phase removes the truncation mode; the completion-notification case
  remains.

---

## 9. Open questions

1. **Same host or separate?** Same host with a second vhost is simplest and sufficient —
   Cloudflare is per-hostname. A separate host is only needed if the goal is also to
   isolate the load, and it brings the Redis reachability problem with it.
2. **Hostname?** `download.bv-brc.org`, `dl.bv-brc.org`, or an alpha-only name while this
   is shaken down.
3. **Does the website's download mechanism follow cross-origin redirects cleanly?** Must
   be verified per mechanism (hidden form / `fetch` / `window.location`) before committing
   to the design.
4. **Rate-limit strategy** — §7.
5. **IP binding: yes or no?** Tightens the token materially; breaks for roaming clients.
6. **Does this extend to all bulk downloads eventually,** or only the ones that currently
   fail? Starting narrow (joins over the rewrite threshold) is lower risk and reversible.

---

## 10. Measurements this plan rests on

All taken 2026-10-28 against alpha through the production proxy chain, so they include
Cloudflare, nginx, and the API.

| what | value |
|---|---|
| CF silence budget | between **120 s** (survives) and **150 s** (cut at 127 s) |
| CF budget resets per byte | yes — 30 s heartbeat sustained 3 minutes |
| nginx `/api/` read timeout | 1800 s, `proxy_buffering off` |
| nginx buffering observed | none — 1 s ticks arrive 1 s apart end to end |
| failure mode past the budget | **HTTP 200 with a truncated body**, not an error |
| Viruses summary fill (comparable walk) | 783 slices, 15,643,163 genomes, **32.8 min** |
| batched slice cost | ~5 s per 20,000 genomes; ~10× cheaper than the join |
