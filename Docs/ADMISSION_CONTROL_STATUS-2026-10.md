# Admission control into Solr — status assessment, October 2026

**Date:** 2026-10-12
**Assesses:** Layers 1, 3 and 4 of `PLAN_SOLR_OVERLOAD_PROTECTION.md`
**Companion to:** `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md` (which covers the join work
and Layer 2)
**Verified against:** production and alpha, 2026-10-12

---

## The question this answers

The overall goal of this workstream is: **make bulk download fast without driving Solr into
OOM or crashes.** The download side is now largely handled — serializer concurrency caps,
the GenBank port off uncontrolled axios, and backpressure throughout the media handlers (see
the amendment and `Docs/MEDIA_HANDLER_BACKPRESSURE_PLAN.md`).

That leaves the admission question: **when too much arrives at once, what says no?**

Short answer: **nothing does.** There is no admission control of any kind in the API today.
What protects Solr is a set of socket-pool caps that bound *parallelism per worker* but
never reject or queue a request. The distinction matters, and the rest of this document is
about why.

---

## Layer 1 — API admission control: NOT IMPLEMENTED

The plan specifies a counting semaphore with separate heavy/interactive pools, returning
**429 + `Retry-After`** when full, with no queuing. Every artifact it names is absent:

| plan artifact | state |
|---|---|
| `lib/SolrAdmissionControl.js` (counting semaphore singleton) | **absent** |
| `middleware/QueryClassifier.js` (sets `req.queryCategory`) | **absent** |
| `queryAdmission` config block | **absent** from `config.js` |
| acquire/release in `APIMethodHandler` / `DistributedQuery` | **absent** |
| `/stats` exposure of pool state | **absent** |

A tree-wide grep for `queryCategory`, `admission`, `Admission`, `semaphore`, `Semaphore`
returns nothing outside `node_modules`. There is no `429` anywhere in `middleware/`,
`routes/`, or `app.js`.

**Confirmed at runtime**, not just by inspection. Six concurrent heavy downloads against
production (`genome_feature`, `limit(25000)`, `download: 1`, `Accept: text/csv`):

```
req1 http=200 wall=1.72s size=2850853
req2 http=200 wall=1.72s size=2850853
req3 http=200 wall=1.68s size=2850853
req4 http=200 wall=1.68s size=2850853
req5 http=200 wall=1.75s size=2850853
req6 http=200 wall=1.66s size=2850853
```

All six admitted, no 429, no queuing delay, timings indistinguishable from a single request
(2.18 s). The plan's target was 2–3 concurrent heavy requests per instance.

### What `/stats` actually reports

`app.js` tracks exactly one number, `active_requests`, incremented on request and
decremented on `finish`. Live: prod `{"active_requests":1}`, alpha `{"active_requests":10}`.

It is a counter, not a gate — nothing reads it to make a decision. Useful for the
socket-exhaustion diagnosis recorded in the hang investigation, but it is not admission
control and should not be mistaken for it.

---

## Layer 3 — per-host admission: NOT IMPLEMENTED

`lib/HostAdmissionControl.js` is absent, and there is no per-hostname tracking anywhere in
`lib/distributed/`. Replica selection in `SolrClusterClient` remains random rather than
load-aware.

This layer was the answer to a specific problem the plan identifies and that is still true:
**arborvitae runs 21 JVMs, balsam 19.** Per-JVM limits do not bound per-host load, because
21 JVMs each admitting N queries still lands 21×N on one machine. Nothing in the API knows
about physical hosts today.

`maxParallelism` is sometimes mistaken for this. It is not — see below.

---

## Layer 4 — Solr self-protection: UNKNOWN cluster-side, but the API cannot consume it

Circuit breakers and the Solr rate limiter are cluster configuration
(`solr.in.sh`, cluster API), so their state is not visible from this repo and is not asserted
here.

**But there is an API-side blocker worth recording:** both mechanisms signal overload by
returning **429**, and the API has no 429 handling at all. Worse than merely ignoring it —
`ShardCursorStream._requestWithRetry` retries on *any* rejection with exponential backoff
(`lib/distributed/ShardCursorStream.js:171-186`), and `_request` rejects on every non-2xx
(`:250`). A 429 is therefore indistinguishable from a transport error and gets **retried up
to `maxRetries` (default 3) times**.

That inverts the intent: a Solr node saying "I am overloaded, back off" would receive up to
four requests instead of one, per shard, from every worker. **Enabling Layer 4 against the
current API would make overload worse, not better.** 429 handling has to land first.

---

## What actually bounds concurrency today

Not nothing — but all of it is socket-pool capping, which is a different thing from
admission control. Every one of these bounds *parallelism*; none of them *rejects* or
*queues* a request, and none is aware of total system load.

| bound | value | scope | what it limits |
|---|---|---|---|
| `solr.agent.maxSockets` (`config.js:92`) | 8 | per worker | main data path → Solr |
| `solr.shortLiveAgent.maxSockets` (`config.js:98`) | 4 | per worker | short-lived Solr calls |
| `DistributedQueryManager` http/https agent | **50** | per worker (singleton) | all distributed shard fetches |
| `maxParallelism` (`config.js:188`) | 8 | per query | concurrent shards per distributed query |
| `prewarmMaxConcurrent` | 50 | per query | prewarm fan-out batch size |
| FASTA serializer agent (`dna+fasta.js:147`, `protein+fasta.js:143`) | 10 | per worker (cached instance) | sequence lookups |
| GenBank agent (`genbank.js`) | 8 | per worker | contig/feature fetches |

Three observations that matter:

**1. `maxParallelism` is per-query, not global.** It caps how many shards *one* distributed
query reads concurrently (`ParallelQueryCoordinator:120`). Ten concurrent distributed queries
means up to 10 × 8 = 80 concurrent shard fetches from one worker — bounded only by the
50-socket agent, then by nothing above that. It is frequently cited as if it were a system
limit. It is not.

**2. The distributed agent is 50 sockets, 6× the main path's 8.** It is a singleton shared
across all distributed queries in a worker, which is the only reason total fan-out is
bounded at all. Multiply by worker count for the real cluster-facing figure.

**3. Prewarm sits inside that cap but doubles the request count.** `prewarmShards` issues an
`await`ed `rows=0` query to *every* shard before the real query runs (see TODO-8). On an
80-shard collection that is 80 extra requests per distributed query, sharing the same 50
sockets. The cap prevents a socket explosion; it does not prevent the duplicated work.

### Why socket caps are not a substitute

A socket cap makes excess work **wait** rather than be **refused**. Under the June attack
pattern — many concurrent downloads, each amplifying ~370× — queueing at the socket layer
produces exactly the failure recorded in the hang investigation: requests pile up behind the
pool with no deadline on the queue wait, the worker holds slots, and clients see a timeout
rather than a clear rejection. The `util/http.js` wall-clock deadline (`3fc64ead`) bounds how
long that wait can last, but bounding the wait is not the same as not queuing.

Admission control's value is precisely that it **sheds** load at a point where the API can
still answer coherently (429 + `Retry-After`), instead of accepting everything and degrading.

---

## Assessment against the stated goal

> optimize high-performance data download while not overloading Solr into OOM or crashes

| half of the goal | state |
|---|---|
| **download performance** | largely addressed — serializer caps, GenBank port, backpressure verified live, distributed query result-identical to the standard path |
| **not overloading Solr** | **partially addressed, and the remaining gaps are the ones that actually caused the crashes** |

Specifically, of the two historical incidents:

- **June 2 scraping** — the amplification side is much better (Layer 2 done, GenBank port
  done, backpressure done). But nothing limits *how many* amplifying requests run at once,
  which was the plan's primary defense. A repeat of the same attack would be slower per
  request and better behaved on memory, but the concurrency that saturated the shard hosts is
  still unbounded above the socket caps.
- **June 25 OOM** — unaddressed. That was broad-taxon joins, covered in the amendment as
  TODO-1, and none of its countermeasures have shipped.

---

## Recommended order

1. **429 handling on inbound Solr responses — before anything else.** Small, and it is a
   prerequisite for Layer 4 being safe to enable. Make `_requestWithRetry` status-aware:
   treat 429 as "back off and honour `Retry-After`", not as a generic retriable error. Same
   for `DirectSolrClient`. Without this, turning on Solr's own protection amplifies overload.
2. **Layer 1 admission control.** The primary defense, and the thing that would most directly
   have blunted the June 2 incident. Returns 429, so it needs coordinated client updates —
   that is the main cost, not the semaphore.
3. **TODO-1 join rejection** (see the amendment). Addresses the June 25 crash class.
   Independent of admission control; can proceed in parallel.
4. **Layer 3 per-host admission.** Only meaningful once distributed query runs somewhere that
   matters — it is off in production today.
5. **Layer 4 cluster config.** Safe only after step 1.

Note steps 2 and 5 both emit 429 to clients, so the "429 System-Wide Requirements" section of
the plan applies to both and should be done once.

---

## Deployment caveat

Distributed query is **off in production** (`distributedQuery.enabled: false`) and on in
alpha. So Layers 3 and 4, and the distributed-path socket caps above, currently describe
alpha. Production's exposure runs through the main path: `maxSockets: 8` per worker plus the
serializer agents.

Production is also 183 commits behind master, so it does not have the Layer 2 work or the
backpressure fixes. **The protection described in this document as "shipped" is not what
production is running.**

---

## Reproducing

```bash
# Layer 1: concurrent heavy downloads -- expect all 200, no 429
for i in 1 2 3 4 5 6; do
  ( curl -s -m 200 -X POST 'https://www.bv-brc.org/api-for-website/genome_feature/' \
      -H 'Content-Type: application/rqlquery+x-www-form-urlencoded' \
      -H 'Accept: text/csv' -H 'download: 1' \
      --data-binary 'eq(genome_id,83332.12)&sort(+feature_id)&limit(25000)' \
      -o /dev/null -w "req$i http=%{http_code} wall=%{time_total}s\n" ) &
done; wait

curl -s https://www.bv-brc.org/api-for-website/stats
```

**Streaming downloads require an explicit `sort()`.** Without it the cursor-paginated stream
fails and returns **HTTP 200 with zero bytes** — I hit this while building the test above.
Always check `size_download`, never just the status code.
