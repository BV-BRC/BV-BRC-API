# API hangs — investigation state, 2026-08-24 (UNRESOLVED)

Handoff note. The hangs are **still occurring**. This records what was ruled out, what
was proven, and the cheapest next steps, so the next session does not re-run disproven
theories.

## Symptom

Requests to `/api-for-website/genome_feature/` hang for minutes. Originally surfaced as a
Cloudflare **524** (origin accepted the TCP connection but sent no HTTP response within
Cloudflare's ~100s limit). After the timeout fix below, they surface as a **500** at 120s.

**Intermittent** — the identical query succeeds immediately on reload. Observed on the
feature-page "cartoon" region fetch.

Representative failing request (a GET, note — not a POST):

```
/genome_feature/?and(eq(genome_id,470.36833),eq(accession,470.36833.con.0001),
  eq(annotation,PATRIC),gt(start,10118),lt(end,20118),ne(feature_type,source))
  &select(feature_id,patric_id,refseq_locus_tag,strand,feature_type,start,end,na_length,gene,product)
  &sort(+start)
```

This is a trivial query: one genome, one contig, a 10 kb window, 25 rows, no facets, no joins.

## Proven

**The 500 is the new timeout firing.** Response `Content-Length: 103` is a byte-exact match
for `{"status":500,"message":"Unable to request the database. Error: Solr request timed out
after 120000ms"}`. So the request **reaches `APIMethodHandler` and waits on Solr for a full
120 s without an answer.**

That is the single most important fact on record: it is not a middleware hang, not a routing
problem, and not a client problem. Something accepts the connection and stays silent.

## Ruled out (do not re-investigate)

| theory | verdict | evidence |
|---|---|---|
| Self-call deadlock | **no** | Peak concurrency 10 (cap is 8/worker × 6). Localhost only 6 req/581 s in the window, vs 4,035 req/374,670 s earlier. |
| nginx keepalive pinning workers | **no** | All six workers serve traffic; worker 47 has the *highest* CPU time. The "idle" workers were a pm2 log-path collision — 47/48/49 all write to `out-8.log`. `nginx -s reload` correctly changed nothing. |
| The alpha→master merge | **unlikely** | The failing query engages **none** of the new middleware — verified: zero intersection between its `select()` and `genome_feature`'s joinable fields (`genome_name`, `taxon_id`, `genome_status`, `strain`); `rows=25` vs distributed threshold 10000 (`shouldUseDistributedQuery` returns false); no `http_source_*`. Socket errors also date to **January 2025**. |
| HAProxy connection shedding | **no** | `solr-api` frontend: `scur` 2–3, `smax` 23–24, `slim` 3000. Nothing pinned at a cap, unlike the GenBank incident where `smax` sat at exactly `maxconn` 40. |
| `maxFreeSockets: 0` disables pooling | **no — my error** | Claimed in-session that it destroys idle sockets so keepAlive buys nothing. **Tested: false.** Node treats `0` as unset and falls back to the default, so idle sockets *are* pooled. The prod agent config is not the problem. |
| Stale keepalive socket | **weakened** | Fit the intermittency, and motivated the timeout fix. But a stale socket fails on *write* (`ECONNRESET`/`EPIPE`) quickly — it does not stay silent for 120 s. Does not explain the current evidence. |
| Network saturation on the proxies | **no** | A 1-hour Ganglia view showed `plum` at ~400 MB/s and `spruce` at ~300 MB/s and looked damning. The **full-day** view shows those bursts are routine — comparable peaks all day, every day, with no hangs. Normal operating condition, not a trigger. (Lesson: do not diagnose from a 1-hour window.) |
| `larch` traffic cliff | **no** | Flat ~20 MB/s until ~06:00 then zero, which looked like a failed host. It is a **Mongo replica**; the traffic was a daily backup run finishing. Not a Solr node. |
| Workspace (`spruce`) slowness | **unlikely** | `util/http.js` has **no timeout mechanism at all**, so `ExpandingQuery`/`transcriptomicsGene` workspace calls can hang unboundedly — a real latent defect (below). But the workspace health monitor did not trigger at any point during the incident day, and the known-failing query contains no workspace-touching RQL term. |

## Changes shipped during the investigation

- **#202** (`bf9c9207`) — alpha→master merge. Verified: audit 35/2 critical, offline suites
  327/1, tree content-identical to alpha.
- **#203** (`6397c6cf`) — Solr request timeout on the main data path.
  `middleware/APIMethodHandler.js` set **no timeout** on any of its four Solr clients, and in
  `lib/solrjs` only `query()` honored `this.timeout`. Now `armTimeout()` covers `query`,
  `get`, `getSchema`, and the streaming path, and `makeSolrClient()` centralizes agent +
  timeout + `X-Authenticated-User`.
  **This did not fix the hang** — it bounded and labeled it. That is still a net win: the
  failure is now diagnosable and the socket slot is released.

## Two verified defects still open

Both found while testing the theories above. Neither is the confirmed root cause, but both
produce *exactly* this user-visible symptom and both are real.

### A. #203 does not bound time spent queued for a socket

`req.setTimeout()` is a **socket** timeout — the timer does not start until the agent assigns
a socket. Time spent waiting in the agent's pending queue is unbounded. Verified with
`maxSockets: 1` against a black-hole server: a request with a 2000 ms timeout was **still
pending after 6000 ms**.

With `maxSockets: 8`, anything that slows Solr responses fills the pool, and request 9 waits
with no timer running. Worst case is therefore *(unbounded queue wait) + 120 s*, not 120 s.
This also explains why some requests land on exactly 120 s (socket available immediately)
while others hang longer.

Fix: a wall-clock deadline started at request creation, alongside the socket timeout, calling
`req.destroy()`. ~10 lines in `armTimeout()`, same call sites, same env var.

### B. `util/http.js` has no timeout mechanism at all

Not merely unset — absent. #203 fixed `lib/solrjs`; `util/http.js` was untouched. It carries:

- the **Workspace API** calls (`ExpandingQuery.js:11`, `rpc/transcriptomicsGene.js:17`)
- **all 17 HTTP self-call sites**

`ExpandingQuery` runs *inside* `RQLQueryParser`, i.e. before the query reaches Solr, and fires
on `GenomeGroup(...)`, `FeatureGroup(...)`, `join(...)`, and `secondDegreeInteraction(...)`
terms. A slow workspace on any of those hangs the request with nothing to bound it — and the
website uses genome groups heavily.

One fix covers A and B: a wall-clock deadline in `util/http.js` plus the queue-wait guard in
`armTimeout()`. Same env-var pattern as #203, ~30 lines total.

## Next steps, cheapest first

**1. Lower the timeout — env var, no deploy, no rollback.**

```bash
# in the pm2 env, then:
pm2 restart p3-api-web --update-env    # SOLR_REQUEST_TIMEOUT_MS=15000
```

15 s is under Cloudflare's limit, so users get a fast error instead of a two-minute spinner,
and failures arrive ~8× more often to sample. 120 s was chosen to clear the slowest
legitimate query (~75 s Solr time on broad facets); that headroom is buying nothing here.

**2. Test the production Solr hop directly — the biggest untested gap.**

Read the **production** `p3api.conf` for the real `solr.url`. (The checkout used during this
investigation was a *development* host whose config points at `localhost:15183`; do not
assume production shares that topology.) Whatever the first hop is, the question is whether
it accepts connections and stays silent under load — which is the observed signature and
would explain healthy HAProxy stats (2–3 concurrent) alongside 120 s API waits.

```bash
# from the production API host, using its configured solr.url:
ss -tlnp "sport = :<port>"          # what is listening?
ss -tnp  "dport = :<port>" | head   # who is connected, how many?

time curl -sk -o /dev/null -w "%{http_code} %{time_total}\n" \
  "<solr.url>/genome_feature/select?q=*:*&rows=1&wt=json" --max-time 30
```

If the curl hangs, it reproduces outside Node and the API is exonerated. If it returns
instantly while the app times out, the problem is in the app's connection handling — which
would point at defect A above (socket-queue exhaustion).

**3. Separate Solr failures from self-call failures in the logs.** The string
`Unable to request the database` is emitted by **both** `lib/solrjs` (4 sites, real Solr) and
`util/http.js` (5 sites, self-calls). They interpolate differently:

```bash
# Solr-side (solrjs interpolates the Error object)
grep -c "Unable to request the database. Error:" /disks/p3/logs/p3-api-web.error-{8,10,11}.log

# self-call side (util/http interpolates err.code only)
grep -cE "Unable to request the database\. (ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT)" \
  /disks/p3/logs/p3-api-web.error-{8,10,11}.log
```

If the volume is **self-call**, that reframes things: self-calls go to localhost, bypass
HAProxy entirely, and would explain healthy HAProxy stats with API-side hangs. It would also
promote `feature/eliminate-self-call` from performance work to bug fix.

**4. Richest single log line.** `APIMethodHandler.js:135` logs user + URL + full query on
Solr failure — use it to see whether failures cluster on one collection, user, or query shape:

```bash
grep "Solr request timed out" /disks/p3/logs/p3-api-web.error-*.log | tail -20
```

**5. `/stats` while hanging.** `active_requests` climbing monotonically means wedged; rising
and falling means merely slow. Different causes.

**6. Test the socket-pool theory directly** — it is now the leading mechanical explanation,
and it is nearly free to test. If pool exhaustion is the cause, raising `maxSockets` should
change the failure rate immediately:

```bash
# in production p3api.conf: solr.agent.maxSockets 8 -> 64, then restart
```

Pair with `/stats`: if `active_requests` is well above 8 per worker while requests hang, they
are queueing for sockets, not waiting on Solr. Note this pushes more concurrency at Solr, so
watch the cluster — `PLAN_SOLR_OVERLOAD_PROTECTION.md` has the standing caveat.

## Traps for the next session

- **A `git checkout` of an older commit is NOT a full rollback.** `node_modules` is not
  reverted, and pre-merge master needs the external `solrjs` package that the merge removed.
  Checkout without `npm ci` gives `Cannot find module 'solrjs'` on every worker. Untracked
  `p3api.conf` and pm2 env vars also survive.
- **Rolling back now also discards #203**, i.e. the only thing making this failure
  diagnosable. To test the merge specifically while keeping the installed dependency tree,
  use `bf9c9207` (identical manifest, no `npm ci` needed).
- **pm2 log paths collide.** Workers 47/48/49 all write to `p3-api-web.out-8.log`; `pm2 scale`
  cloned the resolved paths. Analysis over `out-{8,10,11}.log` therefore covers all six
  workers. Fixing it needs `pm2 delete` + a clean start — `reload`/`scale` preserve it. **Keep
  reading the same three files** until then, or before/after comparisons break.
- **`/api-for-website/` may be a different nginx location** from `/api/`, potentially with its
  own upstream block. Confirm it proxies where you think before tuning anything.
- An **admin token** was pasted into a chat transcript during this session
  (`roles=admin`, expiry 1802556854). **Revoke it.**

## Unrelated, noted in passing

`Unable to resolve RQL query. Illegal character in query string encountered ?` (2026-08-11) —
a literal `?` in RQL that was not URL-encoded. `node_modules/rql/parser.js:119` throws,
`middleware/RQLQueryParser.js:139` returns 400. Encoding as `%3F` parses fine, so it is a
client-side encoding gap — same class as the `&gt;` entity-decode bug. Predates this incident
and is unrelated to it. That log line records neither the query nor the request id, which is
why it is hard to chase after the fact.
