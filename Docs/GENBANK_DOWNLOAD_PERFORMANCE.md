# GenBank Download Performance Investigation

**Date:** 2026-07 · **Branch:** `feature/distributed-query`

## Summary

Large multi-genome GenBank downloads (200 genomes, ~396 MiB) were effectively
unusable: throughput around **2 genomes/min**, multi-minute `0 B/s` freezes
mid-stream, truncated files, and browsers showing "resuming". After this work a
200-genome download completes in **~27 seconds** over the internet through the
production proxy — a ~15× improvement with no stalls or truncation.

The root cause turned out to be **two independent layers**:

1. **Application** — a series of inefficiencies and correctness bugs in the
   GenBank serializer and its request path (this repo).
2. **Infrastructure** — an HAProxy `maxconn` cap that was shedding the API's
   keepalive sockets, which the API then hung on because it had no request
   timeout (HAProxy config, fixed separately).

Neither layer alone explained the symptoms; the fix required both. The
investigation was driven by measurement (a curl+pv reproducer, in-process phase
timing, `strace`, and HAProxy stats) rather than speculation — several plausible
theories were disproven by data along the way.

---

## Timeline of findings

The symptoms shifted as each layer was peeled back. Theories that were
**disproven by measurement** are called out because they shaped the path:

| Observation | Hypothesis | Verdict |
|---|---|---|
| 30s before first byte on `genome_feature` download | serializer draining the whole feature stream to get genome_ids | **confirmed** → retarget to `/genome/` |
| GC death-spiral (+2m stall ~genome 96) | unbounded `res.write` buffering on slow client | **confirmed** → backpressure |
| infinite hang after client abort | `drain` never fires on dead socket | **confirmed** → disconnect handling |
| 0 B/s through proxy, fine direct | nginx `proxy_buffering` | **disproven** (`proxy_buffering off` already set) |
| trivial query 27s while downloads ran | event-loop blocked by sync CPU | **disproven** (`/health` stayed 15ms; `strace` showed idle loop on a timer) |
| socket pool exhaustion (`maxSockets:8`) | leaked Solr sockets | **disproven** (`strace` showed Solr sockets idle) |
| one genome `fetchWait=166714ms`, format=196ms | a single Solr fetch hangs | **confirmed** → stale keepalive socket |
| `smax` pinned at exactly 40 on `solr-web` frontend | HAProxy `global maxconn 40` throttle | **confirmed** → raise maxconn |

The decisive instrumentation was per-phase timing showing a request was
**96.9% fetchWait** (waiting on Solr), 2.6% format (CPU), 0.3% write (client
drain) — which pointed past the serializer entirely to the socket/proxy layer.

---

## Application-layer changes (this repo)

All on `feature/distributed-query`.

| Commit | Change | Problem solved |
|---|---|---|
| `370f7739` | Fix serializer in streaming/download mode | genome_id extraction from stream |
| `06dd7618` | Convert serializer from HTTP self-calls to direct Solr | config-mismatch 404s, overhead |
| `0ed4816c` | Fix LOCUS name truncation | all contigs showed identical LOCUS name |
| `b1d9e738` | Accept `text/gff3` alias (GFF) | 406 on `text/gff3` downloads |
| `7f138ec5` | One feature query per genome | was O(contigs) Solr round-trips |
| `f959a356` | Pipeline genome fetches | overlap Solr I/O with formatting |
| `679c628b` | Honor `res.write` backpressure | unbounded memory / GC spiral on slow clients |
| `b6d7963b` | Disconnect handling | infinite hang when client aborts |
| `1541be98` | Require `/genome/` collection for GenBank downloads | 30s startup drain streaming feature docs |
| `3826cb2c`, `bcfa0a17` | Phase + per-collection fetch timing instrumentation | localized the stall to Solr fetch |
| `5bdf4044` | Solr request timeout + retry + keepalive toggle | backstop for stale keepalive sockets |
| reproducer | `aa33e56a`, `22d725a9`, `0964e2c5`, `021d3820`, `bef18a01`, `dcb93f95` | `scripts/repro-genbank-stall.sh` |

### Notable design decisions

- **GenBank downloads must target the `genome` collection.** The serializer only
  needs the genome_id list and fetches contigs/features itself. Requesting from
  `genome_feature` forced the pipeline to stream millions of feature docs just to
  recover genome_ids. A guard in `routes/dataType.js` now returns `400` with a
  message pointing at `/genome/`. Clients (download UI/links) must use `/genome/`.
- **Uses the standard `Solrjs` client, not `DirectSolrClient`.** Small targeted
  per-genome queries don't benefit from distributed shard fan-out and Solrjs works
  through the HAProxy proxy URL without direct replica access (also enables offsite
  testing).
- **Backpressure + disconnect handling** make the streaming path safe on slow and
  aborting clients without unbounded memory or hangs.
- **Timeout + retry** (`GENBANK_SOLR_TIMEOUT_MS`, `GENBANK_SOLR_RETRIES`,
  `GENBANK_SOLR_KEEPALIVE`) are a client-side backstop: a hung socket fails fast
  and retries on a fresh connection instead of hanging ~166s.

---

## Infrastructure-layer root cause (HAProxy)

The API talks to a pair of HAProxy load balancers
(`p3.theseed.org:7001` → `140.221.78.42` / `.43`), **not** directly to Solr. This
is intentional: HAProxy provides health-checking and automatic failover for Solr
coordinators that have historically hung/crashed.

### The bug

- HAProxy `defaults` had `option http-server-close`, so the API's pooled keepalive
  sockets terminate at **HAProxy's frontend** (Node↔HAProxy), while HAProxy opens a
  fresh backend connection to Solr per request.
- HAProxy `global maxconn` was **40** — a process-wide cap far below the frontend's
  own `slim` of 3000. Stats confirmed it: the `solr-web` frontend `smax` was pinned
  at exactly **40** despite `slim=3000`.
- Under that connection pressure, HAProxy shed idle frontend keepalive sockets to
  reclaim slots. The API's pool still believed those sockets were alive, sent a
  request into a dead connection, and — with **no client request timeout** — hung
  until the OS tore down the TCP connection (~166s).

### Why it was intermittent and hard to catch

- Stale sockets are **undetectable before use**: TCP offers no liveness check
  without sending data, and a silent LB drop leaves no FIN. The request timeout
  *is* the detection mechanism.
- It surfaced late in long downloads (most idle sockets, most connection pressure)
  and not at all on throttled tests — `curl --limit-rate` makes curl the
  bottleneck and masks upstream stalls. Only unthrottled runs revealed it.

### The fix (applied to both HAProxy instances)

- Raise `global maxconn` (40 → 4000).
- Add explicit `timeout http-keep-alive` / `timeout http-request` (were falling
  back to `timeout client` = 500s, so idle keepalives lingered unpredictably).

### Verification (HAProxy stats, before → after)

- `solr-web` frontend `smax`: **40** (pinned at old cap) → **68** (uses headroom).
- Web coordinator backend: previously flapping (`chkdown` up to 5, ~27h cumulative
  downtime) → clean (`chkdown=0`, `downtime=0`, `eresp=0`). Coordinator stability
  also improved from earlier data-API stabilization work.

---

## Results

200 genomes, ~396 MiB, `completeness: OK`, `curl exit 0` in all cases:

| Path | Before | After |
|---|---|---|
| direct to node (localhost) | ~407s, 166s+206s stalls | **27.4s** |
| on-prem → HAProxy | 407s+ | **28.9s** |
| laptop → internet → HAProxy | multi-minute stalls, "resuming", truncation | **26.7s** |

All three paths converge at ~27s — the through-proxy time now equals
direct-to-node, confirming HAProxy no longer adds overhead.

---

## Reproducer

`scripts/repro-genbank-stall.sh <base_url> [rate] [rql]` — streams a large
multi-genome download through `curl | pv`, logging per-interval throughput so a
stall shows as `[0 B/s]` while the timer advances. Reports TTFB, total time,
size, and a completeness check (file must end with `//`).

Key lesson baked into it: **test unthrottled** to see real stream behavior;
`--rate` (curl `--limit-rate`) makes curl the bottleneck and hides upstream
stalls. Use throttling only to simulate a slow client for backpressure tests.

Enable in-process timing with:

```
DEBUG=p3api-server:media:genbank:timing
```

Emits per-genome `fetchWait/format/write` ms and a `REQUEST SUMMARY` with
percentages — the tool that localized the root cause.

---

## Open items / follow-ups

1. **Faster downloads raise peak shard network (general risk, not observed here).**
   With the stall gone, a download runs at full speed, so the same sequence data
   ships from the shards ~15× faster than when the stall was spreading it thin —
   the stall had been acting as an *accidental* rate limiter, and concurrent fast
   downloads will now stack at full speed. This raises the priority of deliberate
   Solr overload protection (see `PLAN_SOLR_OVERLOAD_PROTECTION.md`).

   Note: a 100–200 MB/s all-data-node network spike observed during this work was
   initially suspected to be un-throttled download load, but was traced to
   **scheduled backups** (direct node→network, bypassing HAProxy and the API).
   Two 300s HAProxy stat snapshots taken during the spike showed the API moving
   only ~4.3 MB/s total across both proxies (~0.1 req/s per frontend) — ~50×
   below the node spike — confirming the API was not the source. Steady-state API
   load through the proxies is very light; the old `maxconn 40` cap bit only on
   bursts (e.g. concurrent large downloads pinning `smax=40`), not the baseline.

2. **Concurrent-download CPU under PM2 cluster.** GenBank formatting is
   synchronous CPU (~170ms/genome, ~11s total per download). On a single worker,
   3 concurrent downloads pin one core at 95% and each slows ~2×. Production runs
   PM2 cluster mode (currently 3 workers), which spreads downloads across cores —
   but 3 concurrent large downloads can still saturate all 3 workers and starve
   interactive traffic. If this becomes a real load pattern, add a **cluster-wide
   concurrency cap** (Redis-backed counter, since a per-process cap under cluster
   mode multiplies by worker count). This is the same cross-process-limiting
   problem as broader Solr throttling and should share that mechanism.

3. **Tune `GENBANK_SOLR_TIMEOUT_MS` down** from 30s to ~5s — a healthy fetch is
   ~400ms, so 5s is ample headroom and cuts residual stale-socket recovery from
   30s to 5s.

4. **Keep HAProxy.** The web-coordinator flapping history is exactly why it
   exists (health-check + redispatch). Do not replace it with a static coordinator
   list in the API — that would rebuild HAProxy's failover logic inside the app and
   still leave the stale-socket problem (now handled by timeout+retry).
