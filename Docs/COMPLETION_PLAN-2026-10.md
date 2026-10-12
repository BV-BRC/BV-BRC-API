# Completion plan — download performance and Solr overload protection

**Date:** 2026-10-12
**Goal:** high-performance bulk download from the data API without driving Solr into OOM or
crashes.
**Status of the goal:** the download half is largely done; the overload half is mostly not.
**Inputs:** `PLAN_SOLR_OVERLOAD_PROTECTION.md` (+ its 2026-10 amendment),
`Docs/ADMISSION_CONTROL_STATUS-2026-10.md`, `Docs/MEDIA_HANDLER_BACKPRESSURE_PLAN.md`,
`Docs/TODO.md` (TODO-1 … TODO-11).

This document sequences the remaining work into shippable units. It does not restate the
analysis — each item links to where that lives. Every claim of current state here was
verified against the tree or the live cluster on 2026-10-12.

---

## Where things actually stand

| area | state |
|---|---|
| Serializer concurrency caps (Layer 2) | **done** |
| GenBank port off uncontrolled axios | **done** |
| Media-handler backpressure | **done** and verified live; 4 niche serializers remain (TODO-10) |
| Distributed query subsystem | **done**, live on alpha, off in production, result-identical to the standard path |
| Genome self-join elimination | **done** (~36% of all joins) |
| Outbound wall-clock deadline (`util/http.js`) | **done**; the Solr path still uses queue-blind `req.setTimeout` |
| **Broad-taxon join rejection** | **not started** — caused the 2026-06-25 OOM |
| **Admission control (Layers 1 & 3)** | **not started** — nothing rejects or sheds load |
| **429 handling** | **not started** — a Solr 429 is retried as a transport error |
| Solr circuit breakers (Layer 4) | cluster-side, unknown; **unsafe to enable today** |
| Production deployment | **183 commits behind master**; has almost none of the above |

The two historical incidents map onto the gaps precisely: **June 2 scraping** is better
behaved per-request but its concurrency is still unbounded, and **June 25 OOM** is untouched.

---

## Phase 0 — unblockers (small, no client coordination)

These are prerequisites. None requires a client change, and none is individually large.

### 0.1 — 429 handling on inbound Solr responses (TODO-11)

**Why first:** every later shedding mechanism signals with 429, and today
`ShardCursorStream._requestWithRetry` (`lib/distributed/ShardCursorStream.js:171-186`) retries
*any* rejection up to `maxRetries` with backoff, while `_request` rejects on every non-2xx
(`:250`). `DirectSolrClient` has the identical shape (`:90,:98`). A node saying "I am
overloaded" therefore receives up to four requests instead of one, per shard, per worker.
**Enabling Layer 4 before this makes overload worse.**

- Make the retry status-aware: 429 → honour `Retry-After`, do not consume the
  connection-failure retry budget, surface distinctly from a transport error.
- Same change in `DirectSolrClient`.
- Decide what the API returns upstream when shards shed: propagate 429 or fail the query.
  Propagating is consistent with Phase 2 and should be the default.

**Testable fully offline** against a stub that returns 429 — no live Solr needed.

### 0.2 — Wall-clock deadline on the Solr path

`armTimeout()` (`lib/solrjs/index.js:50`) is `req.setTimeout`, whose timer starts only when
the agent assigns a socket. Measured: with `maxSockets: 1`, a queued request carrying a
1000 ms timeout was **still pending at 4001 ms**, callback never fired. So
`SOLR_REQUEST_TIMEOUT_MS` does not bound queue wait, and worst case is *(unbounded queue
wait) + 120 s*.

Port the `armDeadline` pattern already proven in `util/http.js` (`3fc64ead`) — a plain
`setTimeout` armed at request *creation*. Gate exists:
`tests/test-util/test.httpTimeout.spec.js` has a queue-wait case that fails if someone swaps
it back to `req.setTimeout`; mirror it for solrjs.

### 0.3 — `/stats` instrumentation

Today `/stats` reports one number, `active_requests`. Phases 1 and 2 cannot be tuned without
more: per-pool `{active, depth, oldest_wait_ms, rejected_total}`, and agent queue depth
(`agent.requests`) so it can be confirmed empty once admission lands.

Ship this **with or before** Phase 2, not after — every pool and queue size in that phase is
a guess until it reports real numbers.

---

## Phase 1 — stop the OOM class (TODO-1)

Addresses the June 25 crash. **Independent of admission control** — can run in parallel with
Phase 2 by a different person.

Full measurements and the corrected design: the "Eliminating Cross-Collection Joins" section
of the plan, as amended by `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md`.

### 1.1 — Reject over-broad taxa at the two join sites

Join generation happens in exactly two places, both API-side (never from client input):
`lib/solrjs/rql.js:99` and `routes/dataRouter.js:107`.

**Design constraint found while scoping this, and it shapes the implementation:**
`rq.toSolr()` is **synchronous** (`middleware/RQLQueryParser.js:104`), so a genome-count
lookup cannot happen inside `rql.js`. Two options:

- **(a)** have `toSolr` mark the query (e.g. annotate the emitted join), then gate in a new
  middleware placed after `RQLQueryParser` and before `APIMethodHandler`; or
- **(b)** pass a pre-resolved count/id-set into `toSolr` via its existing `options` argument,
  resolved by that middleware beforehand.

(b) is cleaner — it keeps the decision in one place and leaves `rql.js` a pure function —
but requires the middleware to parse the taxon out of the RQL before `toSolr` runs. **Pick
one before starting; this is the main design decision in Phase 1.**

Threshold: start at **150,000 genomes** (≈12–15 s by the measured curve), configurable. The
plan's original 10,000 is far too aggressive against current data — taxon 1386 has 14,317
genomes and joins in 2.4 s.

Above threshold → **400** with an actionable message. The count itself is a `rows=0` query
against `genome`, ~0.3 s, cacheable per taxon with a long TTL.

> **Product decision required before shipping:** this makes Viruses (15.6M genomes) and
> Bacteria (1.38M) fail fast instead of timing out or taking 74 s. Nobody is served well
> today, but "fails with an explanation" is a different user experience from "eventually
> loads". Settle this early — it may argue for doing 1.2 first so the threshold can be set
> higher.

### 1.2 — Rewrite sub-threshold joins as `{!terms}`

For taxa under the threshold, replace the join with a local id lookup plus
`{!terms f=genome_id cache=false}`. Measured on taxon 1386 (14,317 genomes, all ids):
**769 ms vs 2,447 ms with identical `numFound`** (129,545,777), carrying a 144 KB body. A
5,000-id subset ran in 386 ms.

- **Do this without SQLite initially.** Fetching the id list straight from `genome` costs
  ~0.5 s at 14K ids, so the rewrite wins before any caching exists. `better-sqlite3`, the
  startup build, and the rebuild-after-indexing machinery all come **out** of the critical
  path — revisit only if `/stats` shows the lookup is hot.
- `cache=false` is load-bearing, not a micro-optimization (see the `terms()` analysis in
  CLAUDE.md: 676 ms uncached vs 3,952 ms cached on the co-occurring-clause shape).
- Cap id-list size; a 150K-id body is ~1.5 MB and belongs on the reject path.
- **Depends on shard pages staying POSTs** — the 144 KB body would break under the old 8 KB
  GET ceiling.

### 1.3 — Block `{!join}` in `SolrQuerySanitizer`

Defense in depth only — the plan itself notes no joins come from client input. Implementation
note the plan omits: the sanitizer blocks by **parameter name**, but `{!join}` is a *value*
inside `fq`. Use the existing `findDangerousParamsInString` / `fullyDecode` machinery for a
value-level check, and ensure it does not reject the API's own generated joins (check
ordering against `DecorateQuery` and `rql.js`).

### 1.4 — `timeAllowed`, demoted

Only after 1.1–1.2, and only with `partialResults` handling. Measured: `timeAllowed` does
**not** cap DocSet construction — 10 s budget ran 64.9 s on taxon 2, no effect at all on
taxon 10239, and even a plain non-join query with a 2 s budget ran 6.4 s. Truncated runs
return `partialResults: true`, which nothing surfaces — taxon 2 reported
`numFound: 3,260,130,049` from a truncated join.

Use 15–30 s (well under the 120 s client deadline), and **raise `partialResults` as an
error** rather than returning a truncated count as authoritative. Without that second half
this step adds instances of a bug class we are trying to remove.

---

## Phase 2 — admission control (Layer 1)

The primary defense against the June 2 pattern. Design: "Admission queue design" in
`Docs/ADMISSION_CONTROL_STATUS-2026-10.md`.

### 2.1 — Classifier and pools with a bounded queue

```
heavy        : rows >= 10000 || isDownload || call_method === 'stream'
               2–3 concurrent
heavy queue  : depth ~= 2x pool, wait deadline ~5–10 s
               -> 429 + Retry-After on queue-full OR deadline
interactive  : everything else, 20 concurrent, queue depth ~20, deadline ~1 s
```

Four properties matter more than the numbers:

1. **Bounded depth *and* a wait deadline** — neither alone is sufficient.
2. **Measure wait from arrival, not dequeue** — the `req.setTimeout` mistake one layer up.
3. **Drop queued entries whose client disconnected.** `media/genbank.js:405,923` already
   checks `res.writableEnded || res.destroyed`; nothing else does. Free at dequeue.
4. **Report per-pool stats** (Phase 0.3).

**Do not shrink `maxSockets` to compensate.** It caps concurrency, not queue depth, and
Node's `http.Agent` exposes no queue cap at all — measured, 192 requests queued behind a pool
of 8. Lowering it makes the unobservable agent queue *deeper*. The target relationship is
**admission pool ≤ socket pool**, so admitted work never waits at the agent and the agent
queue becomes slack.

New: `lib/SolrAdmissionControl.js`, `middleware/QueryClassifier.js`, `queryAdmission` config.
Edits: `APIMethodHandler`, `DistributedQuery`, `dataType.js` chain, `app.js` stats.

### 2.2 — Client 429 support

The real cost of Phase 2, and why it needs coordination rather than being a pure API change.
The plan's "429 System-Wide Requirements" applies; CLI tools and the website both need to
honour `Retry-After` **without** tight-loop retrying. Phase 3 emits 429 from a second source,
so do this once, here.

### 2.3 — Revisit the distributed agent's `maxSockets: 50`

**After 2.1, not before.** Today it is the only thing bounding distributed fan-out at all,
since `maxParallelism: 8` is *per query* — N concurrent distributed queries each want 8
shards. Once admission caps concurrent heavy work, re-evaluate. Leave the main path's
`maxSockets: 8` alone unless `/stats` shows its agent queue non-empty under admission.

---

## Phase 3 — cluster-side and per-host

### 3.1 — Layer 4 Solr self-protection

Circuit breakers + rate limiter per node. **Safe only after Phase 0.1.** Both signal with
429, so without status-aware retry the API amplifies the back-pressure signal internally.

### 3.2 — Layer 3 per-host admission

`lib/HostAdmissionControl.js`, load-aware replica selection in `SolrClusterClient`, per-host
tracking in `ShardCursorStream._request` and `DirectSolrClient._request`.

Lower priority than its plan position suggests: **it only affects the distributed path, which
is off in production.** The problem is real (arborvitae runs 21 JVMs, so per-JVM limits do
not bound per-host load) but it is latent until distributed query runs somewhere that
matters.

---

## Phase 4 — deployment

**None of the above protects users until it ships.** Production is at `7f94fc8b`
(2026-08-17), **183 commits behind master**, and master is **42 behind alpha with 0 ahead** —
so the alpha→master merge is clean.

Production today has no Layer 2 work, no backpressure fixes, not even PR #203's Solr request
timeout, and is throwing `ERR_HTTP_HEADERS_SENT` from a defect fixed months ago on both
branches. Its hang behavior is the old unbounded kind, so **production symptoms should not be
matched against measurements taken on alpha or current master.**

- Roll with **`npm ci`**, not a bare checkout — the manifests differ.
- Clean `pm2 delete` + start rather than `reload`/`scale`; that is also the moment to fix the
  colliding pm2 log paths recorded in the hang investigation.
- Watch for the new `Error after headers sent (METHOD URL): <message>` line — that is the
  root cause the current crash has been masking.

Worth deciding whether to deploy incrementally (merge alpha→master now, deploy, then land
Phases 0–2 on the normal cadence) or hold. Incremental is lower-risk per step and gets the
already-finished download work in front of users sooner.

---

## Parallel / independent

Not part of this workstream's critical path, tracked so they are not lost:

| item | note |
|---|---|
| **TODO-10** — 4 serializers lacking backpressure | mechanical; needs live API to verify (assert exact row counts) |
| **TODO-8** — prewarm ungated | 80 extra requests per distributed query on an 80-shard collection; fold into Phase 2 if convenient |
| **TODO-2** — Global Search zero results | breaking, but the fix is client-side in bvbrc_website |
| **TODO-3** — silent 200 on solrjs stream failure | same bug *class* as several already fixed |
| **TODO-4** — ACL field disclosure | open security finding; needs a disclosure-path decision |
| **TODO-6** — `genome.cds` discrepancy | would unblock a 0.3 s fast path for summary counts |
| **TODO-9** — self-call elimination step 3+ | its step 7 overlaps Phase 0.2 |
| 8 dependabot PRs against master | fold into the Phase 4 merge |

---

## Suggested order

```
Phase 0.1  429 handling              ──┐ offline-testable, unblocks everything
Phase 0.2  solr-path deadline          │ no client impact
Phase 0.3  /stats instrumentation    ──┘
                │
     ┌──────────┴──────────┐
Phase 1 (joins/OOM)   Phase 2 (admission)   ← parallelizable, different people
     │                     │  2.2 client 429 work is the long pole
     └──────────┬──────────┘
Phase 3  Layer 4, then Layer 3
                │
Phase 4  deploy  ← or do an incremental deploy before Phase 1
```

**First three things to do, concretely:** 0.1 (offline-testable, small, unblocks Layer 4);
settle the Phase 1 product question about rejecting Bacteria/Viruses; and decide whether
Phase 4 happens incrementally, because that choice affects how everything else is staged.
