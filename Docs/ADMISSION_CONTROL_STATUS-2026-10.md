# Admission control into Solr — status assessment, October 2026

**Date:** 2026-10-12 — **substantially superseded 2026-10-16, see below**
**Assesses:** Layers 1, 3 and 4 of `PLAN_SOLR_OVERLOAD_PROTECTION.md`
**Companion to:** `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md` (which covers the join work
and Layer 2)
**Verified against:** production and alpha, 2026-10-12

> ## STATUS UPDATE 2026-10-16 — Layer 1 is now implemented
>
> **This document was written as a gap analysis when nothing existed. Layer 1 has since
> shipped, so the "NOT IMPLEMENTED" sections below describe the state on 2026-10-12, not
> today.** They are kept because the reasoning — especially *why* a bounded queue beats
> both an unbounded agent queue and a no-queue rejection — is what the implementation was
> built from.
>
> | layer | state today |
> |---|---|
> | **Layer 1** — API admission control | **IMPLEMENTED**, PR #231, merged and deployed to alpha. `lib/SolrAdmissionControl.js`, `middleware/QueryClassifier.js`, `queryAdmission` config, pool state at `/stats`. **Ships disabled**; enabling returns 429, which needs client `Retry-After` support first. |
> | **Layer 3** — per-host admission | still not implemented (Phase 3.2) |
> | **Layer 4** — Solr circuit breakers | cluster-side; **now safe to enable** — PR #226 fixed the 429-retry inversion that made it dangerous |
> | 429 handling | **IMPLEMENTED**, PR #226 |
> | wall-clock deadline on the Solr path | **IMPLEMENTED**, PR #228 |
> | `/stats` socket-pool visibility | **IMPLEMENTED**, PR #229 |
>
> **Measured 2026-10-16:** `Docs/ADMISSION_CONTROL_MEASUREMENT-2026-10-16.md` — a paired
> A/B against alpha with Solr JVM/GC sampled throughout. Admission roughly **doubled
> throughput** (27 vs 12 identical load passes in equal time), held latency flat (9.0 s
> mean vs 20.3 s and climbing), kept the socket queue at **0 vs a peak of 17**, and cut
> filterCache evictions per request **2.9×**. It did **not** demonstrate heap protection —
> zero old-gen collections on all 97 JVMs in both runs — so that case still rests on the
> June incident analysis and Phase 1's join rejection.
>
> Sequencing for what remains: `Docs/COMPLETION_PLAN-2026-10.md`.

---

## The question this answers

The overall goal of this workstream is: **make bulk download fast without driving Solr into
OOM or crashes.** The download side is now largely handled — serializer concurrency caps,
the GenBank port off uncontrolled axios, and backpressure throughout the media handlers (see
the amendment and `Docs/MEDIA_HANDLER_BACKPRESSURE_PLAN.md`).

That leaves the admission question: **when too much arrives at once, what says no?**

Short answer **as of 2026-10-12**: nothing did. There was no admission control of any kind
in the API; what protected Solr was a set of socket-pool caps that bound *parallelism per
worker* but never reject or queue a request. The distinction matters, and the rest of this
document is about why.

**As of 2026-10-16 that is fixed** — Layer 1 shipped in PR #231. Read the sections below as
the analysis that motivated it, not as current state.

---

## Layer 1 — API admission control: ~~NOT IMPLEMENTED~~ **shipped 2026-10-16 (PR #231)**

*The analysis below describes 2026-10-12 and is retained because it is what the
implementation was built from. Current state is in the right-hand column.*

The plan specifies a counting semaphore with separate heavy/interactive pools, returning
**429 + `Retry-After`** when full, with no queuing. Every artifact it names was absent:

| plan artifact | state on 2026-10-12 | today |
|---|---|---|
| `lib/SolrAdmissionControl.js` (counting semaphore singleton) | absent | **exists** |
| `middleware/QueryClassifier.js` (sets `req.queryCategory`) | absent | **exists** |
| `queryAdmission` config block | absent from `config.js` | **present** |
| acquire/release in `APIMethodHandler` / `DistributedQuery` | absent | **in `QueryClassifier`** — it holds the slot for the whole response, not just the Solr call, because a streaming download keeps amplifying while it writes |
| `/stats` exposure of pool state | absent | **under `admission`** |

**One deliberate departure from the plan: "no queuing" was not an available choice.**
`maxSockets: 8` already queues inside Node's `http.Agent`, with no depth cap and — before
PR #228 — no time bound either. The shipped design keeps the plan's pool sizes and puts a
short, bounded, instrumented queue in front, so the waiting happens somewhere it can be
capped, timed and observed. See "Admission queue design" below.

A tree-wide grep for `queryCategory`, `admission`, `Admission`, `semaphore`, `Semaphore`
returned nothing outside `node_modules`. There was no `429` anywhere in `middleware/`,
`routes/`, or `app.js`. (All of those now exist.)

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

**Re-run 2026-10-16 with Layer 1 enabled, same workload at higher concurrency:** 40
simultaneous heavy downloads produced 25 completed and 15 shed with
`429 + Retry-After: 10`, with concurrency pinned at the configured 3. The behavior the
paragraph above reports as missing is now present and measured.

### What `/stats` actually reports

~~`app.js` tracks exactly one number, `active_requests`~~ — true on 2026-10-12. PRs #229
and #231 added `agents` (per-pool socket `active`/`free`/**`queued`**),
`sockets_queued_total`, and `admission` (per-pool `active`, `depth`, `oldest_wait_ms` and
cumulative admitted/queued/rejected counters). `active_requests` is unchanged at the top
level, because existing monitoring reads it.

The original point still stands for `active_requests` itself: it is a counter, not a gate —
nothing reads it to make a decision. It was useful for the socket-exhaustion diagnosis in
the hang investigation, but it is not admission control and should not be mistaken for it.

---

## Layer 3 — per-host admission: NOT IMPLEMENTED (still true as of 2026-10-16)

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

**There was an API-side blocker — fixed 2026-10-16 by PR #226, so Layer 4 is now safe to
enable.** The problem was that both mechanisms signal overload by returning **429**, and
the API had no 429 handling at all. Worse than merely ignoring it:
`ShardCursorStream._requestWithRetry` retried on *any* rejection with exponential backoff,
and `_request` rejected on every non-2xx. A 429 was therefore indistinguishable from a
transport error and got **retried up to `maxRetries` (default 3) times** — so a node saying
"I am overloaded, back off" received up to four requests instead of one, per shard, from
every worker.

PR #226 made the retry status-aware: a 429 is now paced on the server's `Retry-After`
against a separate, smaller budget (`maxOverloadRetries`, default 1), and non-429 4xx are
not retried at all. `lib/solrHttpError.js` preserves the status and parsed `Retry-After`
through all four Solr clients.

**Layer 4 remains the one unvalidated piece here:** cluster-side configuration state is
still not visible from this repo, so whether circuit breakers are actually enabled is not
asserted — only that turning them on no longer backfires.

---

## What bounded concurrency before Layer 1

*As of 2026-10-12. Layer 1 now sits above all of these; the table remains accurate as a
description of the socket pools themselves, which are unchanged.*

Not nothing — but all of it was socket-pool capping, which is a different thing from
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

| half of the goal | state on 2026-10-12 | state on 2026-10-16 |
|---|---|---|
| **download performance** | largely addressed | unchanged, and now **measured**: admission roughly doubles throughput under load rather than costing it |
| **not overloading Solr** | partially addressed; the remaining gaps were the ones that caused the crashes | **both gaps closed in code**; one is validated, the other is argued from incident analysis |

Of the two historical incidents:

- **June 2 scraping** — *then:* amplification was much better (Layer 2, GenBank port,
  backpressure) but nothing limited *how many* amplifying requests ran at once, which was
  the plan's primary defense. *Now:* Layer 1 bounds it. Measured 2026-10-16 — 40 concurrent
  heavy downloads reach Solr as 3, with the rest queued briefly or shed with 429, and
  throughput roughly **doubles** rather than degrading.
- **June 25 OOM** — *then:* unaddressed. *Now:* Phase 1 (PR #230) refuses broad-taxon joins
  at the API; taxa above the threshold return 400 in under a second where they previously
  burned 120 s, and the `{!terms}` rewrite returns identical results 3–6× faster.

**The honest limit on all of this:** the 2026-10-16 A/B showed **zero old-gen collections
on all 97 JVMs in both the admission-on and admission-off runs**. The cluster was never
under heap pressure at that load, so the measurement validates Layer 1 as a throughput,
latency and contention mechanism — not as demonstrated heap protection. That case still
rests on the June incident analysis and on Phase 1's join rejection. Full detail and
caveats: `Docs/ADMISSION_CONTROL_MEASUREMENT-2026-10-16.md`.

---

## Admission queue design (added 2026-10-12)

The plan specifies Layer 1 as *"Returns 429 with `Retry-After` when pool is full — **no
queuing**."* That phrasing should change, for an empirical reason.

### "No queuing" is not one of the options

With `maxSockets: 8`, request 9 does not fail — Node's agent holds it until a socket frees.
That is a queue. Measured directly against a black-hole server:

```
maxSockets              : 8
active sockets          : 8
QUEUED (agent.requests) : 192        <- 200 requests fired at a pool of 8
queue cap options       : NONE
```

Node's `http.Agent` exposes **no** `maxQueue` / `maxPending` / `maxRequests` option. The
queue is unbounded by construction, and it has three properties you would not choose:

1. **Unbounded depth.** Nothing caps the pile-up behind the pool.
2. **Invisible.** `/stats` reports only `active_requests`. Queue depth and wait time are not
   observable anywhere.
3. **Not time-bounded on the Solr path.** `armTimeout()` in `lib/solrjs/index.js:50` is
   `req.setTimeout`, whose timer starts when the agent *assigns a socket*. Measured: with
   `maxSockets: 1`, a queued request with a 1000 ms `setTimeout` was **still pending after
   4001 ms** and the callback never fired. Worst case on this path is therefore *(unbounded
   queue wait) + `SOLR_REQUEST_TIMEOUT_MS`*. Only `util/http.js` has the creation-time
   deadline (`3fc64ead`, `armDeadline`); the Solr path never got it.

So the choice is not *whether* to queue. It is **where the queue lives, and whether it is
bounded**. Leaving it in the agent is the worst available answer.

### What an explicit queue buys

**It turns the common case from a rejection into a slightly slower success.** Heavy requests
here run for seconds — a 25K-row CSV is ~1.7 s; a multi-genome GenBank export far longer.
Against a pool of 2–3, five arrivals inside a second is not an attack, it is a few users and
a script. Rejecting them discards work the client must redo, and clients that retry on 429
reproduce the retry amplification already blamed for the 2026-06-05 coordinator crash.

**It makes saturation observable.** Queue depth and oldest-wait are the two numbers that say
whether you are near capacity. Neither exists today — the same blind spot that made the
September coordinator wedge hard to characterise.

### Shape

```
heavy        : 2–3 concurrent                    (unchanged from the plan)
heavy queue  : depth ~= 2x pool, wait deadline ~5–10 s
               -> 429 + Retry-After on queue-full OR deadline exceeded
interactive  : 20 concurrent, queue depth ~20, wait deadline ~1 s
```

The numbers are starting points and need a real workload; the properties matter more:

1. **Bounded depth *and* a wait deadline.** A queue with neither is a slower OOM. Exceed
   either → 429. That is the whole difference between "defer briefly" and "accept unbounded
   work."
2. **Measure the wait from request arrival, not from dequeue.** This is exactly the
   `req.setTimeout` mistake above, one layer up, and it would be easy to repeat.
3. **Drop queued entries whose client has disconnected.** Most abandoned bulk downloads are
   a closed tab. `media/genbank.js:405,923` already checks `res.writableEnded ||
   res.destroyed`; nothing else does. Checking at dequeue is free and avoids doing work for
   nobody.
4. **Expose `{depth, oldest_wait_ms, rejected_total}` per pool at `/stats`.** Without it the
   pool sizes above cannot be tuned.

### Should the socket-level queues shrink too?

**No — and they cannot be bounded anyway.** `maxSockets` caps *concurrency*, not queue depth,
and as measured above there is no option to cap the agent's queue. Lowering `maxSockets`
would make the unbounded agent queue **deeper**, not shallower, since the same arrivals wait
on fewer sockets. It moves load into the least observable place in the system.

The correct relationship is the opposite of shrinking:

> **Admission pool size must be ≤ socket pool size, so the socket queue stays empty.**

If heavy admission is 2–3 concurrent and the main Solr agent allows 8 sockets, admitted work
never queues at the agent — it gets a socket immediately. The agent queue stops being a
load-bearing structure and becomes slack. **That is the goal: not a smaller socket queue, an
unused one.**

Two sizing notes that follow:

- **`maxSockets: 8` on the main path is probably about right** once admission exists, because
  one admitted heavy request can itself issue several concurrent Solr calls. Leave it until
  `/stats` shows the agent queue is actually non-empty under admission.
- **The distributed agent's `maxSockets: 50`** (`DistributedQueryManager.js:68,74`) is the
  one worth revisiting, but *after* admission lands, not before — today it is the only thing
  bounding distributed fan-out at all (`maxParallelism` is per-query, so N concurrent
  distributed queries can each want 8 shards). Shrinking it now would deepen the agent queue
  with nothing above it; shrinking it once admission caps concurrent heavy work is a safe
  second step.

### Sequencing caveats

- **Per-worker, not cluster-wide.** These pools are worker-local, so cluster-facing
  concurrency is pool size × worker count. The plan acknowledges this ("2 heavy downloads ×
  3 instances"), but it means queue sizing cannot be reasoned about one worker at a time.
  Note also the pm2 log-path collision recorded in the hang investigation makes per-worker
  stats harder to read than they appear.
- **TODO-11 must land first.** If Layer 1 starts emitting 429 while
  `ShardCursorStream._requestWithRetry` still treats an inbound 429 as a generic retriable
  error, the system amplifies its own back-pressure signal internally.

---

## Recommended order

**Progress as of 2026-10-16: steps 1, 2 and 3 are done** (PRs #226, #231, #230). Steps 4–6
remain, plus the two follow-ups below.

1. ~~**429 handling on inbound Solr responses — before anything else.**~~ **DONE (PR #226).** Small, and it is a
   prerequisite for Layer 4 being safe to enable. Make `_requestWithRetry` status-aware:
   treat 429 as "back off and honour `Retry-After`", not as a generic retriable error. Same
   for `DirectSolrClient`. Without this, turning on Solr's own protection amplifies overload.
2. ~~**Layer 1 admission control, with the bounded queue described above.**~~ **DONE (PR #231), shipped disabled.** The primary
   defense, and the thing that would most directly have blunted the June 2 incident. Returns
   429, so it needs coordinated client updates — that is the main cost, not the semaphore.
   Ship `/stats` instrumentation in the same change; without it the pool and queue sizes
   cannot be tuned.
3. ~~**TODO-1 join rejection**~~ **DONE (PR #230).** Addresses the June 25 crash class.
   Independent of admission control; can proceed in parallel.
4. **Revisit the distributed agent's `maxSockets: 50`** — only *after* step 2, when admission
   caps concurrent heavy work. Doing it earlier deepens an unbounded, unobservable agent
   queue. Leave the main path's `maxSockets: 8` alone unless `/stats` shows the agent queue
   is non-empty under admission.
5. **Layer 3 per-host admission.** Only meaningful once distributed query runs somewhere that
   matters — it is off in production today.
6. **Layer 4 cluster config.** ~~Safe only after step 1~~ — step 1 is done, so this is now **unblocked**.

Note steps 2 and 6 both emit 429 to clients, so the "429 System-Wide Requirements" section of
the plan applies to both and should be done once. **This is now the gating item for turning
Layer 1 on:** it ships disabled precisely because nothing in the CLI or website honours
`Retry-After` yet, and a client that retries tightly reproduces the amplification blamed for
the 2026-06-05 coordinator crash.

Two follow-ups the 2026-10-16 measurement added:

- **Consider raising `heavyMaxConcurrent` from 3 to 6.** At 3 it shed 21% of offered
  requests while the cluster showed no stress at all (zero old-gen GC, peak heap ~55% on the
  worst single JVM). 6 stays well under the 8-socket Solr pool, so it preserves the
  "socket queue stays empty" property that the A/B confirmed matters.
- **`heavyMaxWaitMs: 10000` is fine as shipped.** An earlier run suggested lowering it, but
  that run's timeout-heavy rejections reflected a slow cluster rather than a bad deadline —
  in the clean A/B only 4 of ~85 rejections were wait-timeouts.

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
