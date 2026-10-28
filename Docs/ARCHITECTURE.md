# BV-BRC Data API — architecture, with the performance controls in place

**Date:** 2026-10-16
**Verified against:** `alpha` at `b77fffe6`
**Audience:** someone who needs to change this code and wants to know what sits where, and
why the overload protections are positioned as they are.

CLAUDE.md is the operational reference — individual gotchas, debug namespaces, test
procedures. This is the map: what the components are, how a request moves through them,
and where each performance control sits and why it has to sit there.

---

## 1. The shape of the thing

The API is an Express gateway in front of a SolrCloud cluster. It speaks two query
languages (RQL and raw Solr), serves seventeen output formats, and reaches Solr by four
different transports depending on the request.

```
                         ┌──────────────┐
   clients ────────────▶ │  Cloudflare  │  ~100s origin limit (this matters: it
   (web, CLI, P3DataAPI) └──────┬───────┘   fires before many of our own timeouts)
                                │
                         ┌──────▼───────┐
                         │    nginx     │
                         └──────┬───────┘
                                │
                      ┌─────────▼──────────┐
                      │  API-facing HAProxy │
                      └─────────┬──────────┘
                                │
        ┌───────────────────────▼────────────────────────┐
        │  p3_api workers (pm2 cluster, host: elm)       │
        │  3 main · 3 web · 3 internal · 3 bulk          │
        └───────────────────────┬────────────────────────┘
                                │
         ┌──────────────────────┼─────────────────────────┐
         │                      │                         │
  ┌──────▼───────┐    ┌─────────▼─────────┐   ┌───────────▼──────────┐
  │ Solr-facing  │    │  DirectSolrClient │   │  SolrClusterClient   │
  │   HAProxy    │    │  (direct replica) │   │  (CLUSTERSTATUS)     │
  │ plum · grape │    └─────────┬─────────┘   └───────────┬──────────┘
  └──────┬───────┘              │                         │
         │                      └────────────┬────────────┘
  ┌──────▼─────────┐                         │
  │  coordinators  │                         │
  │ walnut chestnut│                         │
  └──────┬─────────┘                         │
         └───────────────┬───────────────────┘
                         │
    ┌────────────────────▼─────────────────────────────────────┐
    │  SolrCloud — 97 JVMs across 9 hosts                      │
    │  genome_feature: 80 shards │ feature_sequence: 30        │
    │  genome: 1 (alias genome_v02) │ taxonomy: 1              │
    │  arborvitae 15 JVMs · balsam 14 · bio-gp1/2/3 12 each    │
    │  butternut 10 · willow 10 · magnolia 8 · cottonwood 4    │
    └──────────────────────────────────────────────────────────┘
```

**Two facts that shape everything downstream.** First, `genome_feature` has **80 shards**,
so any query against it is a fan-out — one client request becomes eighty Solr requests.
Second, several hosts run **12–15 JVMs each**, so a per-JVM limit does not bound per-host
load. Both are why the controls are where they are.

---

## 2. Request routing

`app.js` mounts a handful of routers. Only the first is on the hot path.

| mount | router | what it serves |
|---|---|---|
| `/:dataType/` | `routes/dataType.js` | **the main data path** — query, get, schema for every collection |
| `/data/*` | `routes/dataRouter.js` | summary endpoints (`summary_by_taxon`, `distinct`, `taxon_category`), Redis-cached |
| `POST /` | `routes/rpcHandler.js` | JSON-RPC (cluster, msa, proteinFamily, transcriptomics…) |
| `/query` | `routes/multiQuery.js` | batched multi-collection queries |
| `/jbrowse/` | `routes/JBrowse.js` | genome browser |
| `/stats`, `/health` | inline in `app.js` | **operational surface — see §6** |

Everything that follows is about `/:dataType/`, because that is where the load is and where
all the controls live.

---

## 3. The middleware chain

This is the spine of the system. Order is load-bearing — several controls are correct only
at their specific position, and at least two bugs this year came from getting that wrong.

```
  http-params          http_* query params → headers
  auth                 p3-user token validation → req.user
  PublicDataTypes      which collections skip permission filtering
       │
  genbankCollectionGuard   reject GenBank on non-genome collections (400)
  _originalRql snapshot    capture client RQL before it is rewritten
       │
  RQLQueryParser       RQL → Solr. EMITS {!join} for genome() clauses.
  SolrQuerySanitizer   ░ block SSRF params + foreign joins
  DecorateQuery        permission fq on the OUTER query
  Limiter              ░ normalize rows; cap fixed-id queries
  CrossCollectionSource    validate/scope http_source_* (inert when absent)
  JoinResolution       ░ REJECT over-broad joins / REWRITE small ones
  QueryClassifier      ░ ADMISSION: acquire a slot (inert unless enabled)
  JoinFieldInjector    inject join keys into fl=
  DistributedQuery     ░ route large queries to the parallel shard path
  ShardsPreference     shards.preference for replica selection
  checkIfStreaming     query → stream for downloads
  CrossCollectionStream    source→target resolution stream (inert unless used)
  APIMethodHandler     ░ EXECUTE against Solr
  reqCounter · ExtractCustomFields · ContentRange
  JoinEnrichment       decorate paginated results from related collections
  media                ░ content negotiation + serialization (backpressure)

  ░ = carries a performance control
```

### Why the order is what it is

**`SolrQuerySanitizer` after `RQLQueryParser`** — and this is the trap. By the time the
sanitizer runs, `call_params` already contains the `{!join}` the parser just generated for
an RQL `genome()` clause. A client-join check that keys off request metadata will therefore
reject the API's own queries. That exact bug took every `genome()` query on alpha to a 400
for one deploy. The check now keys off **the join's shape** —
`method=crossCollection fromIndex=genome` is ours, anything else is not.

**`JoinResolution` after `DecorateQuery`** so the outer permission `fq` is already attached
and survives the rewrite untouched; **before `DistributedQuery`** because rewriting a join
into `{!terms}` changes the query that path will execute.

**`QueryClassifier` after `Limiter`** because `Limiter` is what normalizes `rows`. Classify
before it and you read the client's unbounded `999999999` and call nearly everything heavy.
**After `JoinResolution`** so an over-broad join is refused with a 400 without ever
occupying an admission slot — rejecting is cheaper than queueing.

**`media` last**, because content negotiation needs the result shape, and the serializers
are where backpressure is applied.

---

## 4. Transports — four ways this code reaches Solr

A recurring source of confusion. The same logical query can travel by any of these.

| transport | used by | path to Solr | socket pool |
|---|---|---|---|
| **`lib/solrjs`** | `APIMethodHandler` (the normal path), GenBank | HAProxy → coordinator → shards | `solr.agent`, **maxSockets 8** |
| **`DirectSolrClient`** | FASTA serializers, cross-collection resolution | **direct to replicas**, bypassing coordinators | per-serializer agent, **maxSockets 10** |
| **`ShardCursorStream`** | the distributed path | **direct to each shard replica**, POST per cursor page | `DistributedQueryManager` agent, **maxSockets 50** |
| **`util/http.js`** | Workspace calls, remaining self-call sites | the API's own port, or external | per-call |

**Why `maxSockets` differs so much:** the distributed agent is a singleton shared across all
distributed queries in a worker, and `maxParallelism` is **per query** — N concurrent
queries each want up to `maxParallelism` shards. That 50 is the only thing bounding total
distributed fan-out, which is why §5 says not to shrink it before admission control is on.

**GenBank deliberately uses `lib/solrjs`, not `DirectSolrClient`.** Its secondary fetches are
small single-genome queries that gain nothing from parallel fan-out, and `DirectSolrClient`
needs direct network access to every replica. Production HAS that; an off-site dev
laptop does not, and neither does anything reaching Solr through a proxy URL — so a path
built on it could not be developed or tested where the work happens. (Corrected
2026-10-27: this previously said production lacked the access. It does not.)

---

## 5. The performance controls

Six controls, layered. Each exists because of a specific incident or measurement.

### 5.1 Join admission — `lib/joinResolver.js` + `middleware/JoinResolution.js`

**The OOM guard.** On 2026-06-25 three data nodes died: a cross-collection join over
`taxon_lineage_ids:2` (all Bacteria) materialized 57–93M-document DocSets *per shard* and
held them for the query's life — up to 330 s.

Joins are generated in exactly two places, never from client input:

- `lib/solrjs/rql.js:99` — the RQL `genome()` clause, filter trailing the brace
- `routes/dataRouter.js` — `summary_by_taxon`, filter in a `v=` local param

*Both spellings must be matched.* Handling only the first leaves `summary_by_taxon` — the
endpoint whose 120 s timeouts started the investigation — unprotected.

Before a join reaches Solr, the resolver counts its genome set:

| genomes | action |
|---|---|
| ≤ 50,000 | **rewrite** to `{!terms f=genome_id cache=false}` with the resolved ids |
| ≤ 150,000 | leave the join intact |
| > 150,000 | **refuse** with 400 and an actionable message |

Measured (taxon 1386, 14,317 genomes): the rewrite returns **identical `numFound`
(129,545,777)** in **6,047 ms** against the join's **37,163 ms** — 6.15× faster. Viruses
(15.6M) and Firmicutes (327K) now 400 in under a second where they previously burned 120 s.

Two subtleties worth preserving. The join filter is an **arbitrary genome query**, not just
a taxon — `genome_status:Complete` is 10.3M genomes and also timed out, so the gate is
generic. And `toSolr()` is **synchronous**, so resolution cannot happen where the join is
generated; it operates on the emitted Solr string, where all three `toSolr` callers
converge.

`cache=false` is load-bearing, not cosmetic: a cached terms filter makes Solr materialize
the DocSet up front and drive iteration from the scored query — 3,952 ms versus 676 ms
uncached on a query carrying another clause.

### 5.2 Layer 1 admission — `lib/SolrAdmissionControl.js` + `middleware/QueryClassifier.js`

**Bounds how many amplifying requests run at once.** The June 2026 scraping incidents were
not the genome queries but their amplification: each FASTA download fans out to ~370
secondary `feature_sequence` lookups.

```
heavy       = rows >= 10000 || isDownload || call_method === 'stream'
              3 slots, 6 queue, 10s wait → 429 + Retry-After
interactive = everything else
              20 slots, 20 queue, 1s wait
```

**Ships disabled** (`queryAdmission.enabled: false`) — enforcement returns 429 and nothing
in the CLI or website honours `Retry-After` yet. It still classifies and reports at
`/stats`, so it can be dry-run first.

The design departs from the original plan, which said "no queuing". That was not an
available choice: `maxSockets: 8` **already queues**, inside Node's `http.Agent`, with no
depth cap (measured: 192 requests behind a pool of 8) and no time bound. So the question is
not whether to queue but **where the queue lives and whether it is bounded**. Four
properties matter more than the numbers:

1. bounded depth **and** a wait deadline — either alone is insufficient
2. the wait measured **from arrival**, not dequeue
3. queued entries whose client disconnected are dropped
4. everything counted, for tuning

The slot is held **until the response finishes**, not until the Solr call returns — a
streaming download keeps amplifying while it writes.

**Measured A/B** (`Docs/ADMISSION_CONTROL_MEASUREMENT-2026-10-16.md`): admission roughly
**doubled throughput** (27 vs 12 identical load passes in equal time), held latency flat
(9.0 s vs 20.3 s and climbing), kept the socket queue at **0 vs a peak of 17**, and cut
filterCache evictions per request **2.9×**.

### 5.3 Request deadlines

The recurring failure in this codebase is an outbound call with no deadline. A connection
accepted but never answered — classically a pooled keepAlive socket the far side dropped,
leaving no FIN — hangs until the OS tears down the session (~166 s measured), by which time
Cloudflare's ~100 s limit has already shown the user a 524.

Both `util/http.js` and `lib/solrjs` now arm a **wall-clock deadline at request creation** —
a plain `setTimeout`, deliberately **not** `req.setTimeout`.

*Why that distinction is the whole point:* `req.setTimeout` is a socket inactivity timer
that does not start until the agent assigns a socket. With the pool saturated, a request
waits in `agent.requests` with no timer running at all. Measured with `maxSockets: 1`: a
queued request carrying a 1000 ms `setTimeout` was **still pending after 4001 ms**.

A second, subtler requirement: the deadline must **reject**, not merely destroy.
`req.destroy()` on a request that has no socket yet emits **no `'error'` event**, so nothing
settles the promise — measured at 59.9 s for a 1000 ms deadline before this was fixed.

### 5.4 Back-pressure on `429`/`503` — `lib/solrHttpError.js`

Every Solr client collapsed non-2xx into a bare `Error`, discarding the status, while
`ShardCursorStream` retried *any* rejection up to `maxRetries`. A 429 — "I am overloaded,
stop sending" — was therefore retried up to four times, per shard, per worker. **The signal
that exists to shed load amplified it.**

Now the status survives: 429 is paced on the server's `Retry-After` against a separate
small budget (`maxOverloadRetries`, default 1), and non-429 4xx are not retried at all.
This is what makes Solr's own circuit breakers (Layer 4) safe to enable.

### 5.5 Serializer concurrency and backpressure — `media/`

Each serializer caps its own socket pool (FASTA 10, GenBank 8) and honours `res.write`
backpressure through `util/streamWithBackpressure.js`, so memory stays bounded on a slow
client. Verified live: a throttled download tracks the client's rate rather than the server
racing ahead and buffering.

Four niche serializers still lack it — `cufflinks+gff`, `sralign+dna+fasta`, and the two
`jsonh` FASTA variants (TODO-10).

### 5.6 Socket pools — the layer underneath

| pool | sockets | scope |
|---|---|---|
| `solr.agent` | 8 | main data path, per worker |
| `solr.shortLiveAgent` | 4 | short-lived calls |
| `DistributedQueryManager` | 50 | all distributed fetches, per worker |
| FASTA serializers | 10 | sequence lookups, per worker |
| GenBank | 8 | contig/feature fetches |

**Do not shrink these to compensate for load.** `maxSockets` caps *concurrency*, not queue
depth, and Node exposes no queue cap. Lowering it makes the unobservable agent queue
*deeper*. The target relationship is **admission pool ≤ socket pool, so the socket queue
stays empty** — confirmed by measurement: 0 queued with admission on, peak 17 without.

---

## 6. Observability — `/stats`

The one place to look when something is wrong.

```json
{
  "active_requests": 1,
  "uptime_s": 1402, "pid": 1479515,
  "agents": {
    "solr.main":      {"active":0,"free":0,"queued":0,"maxSockets":8},
    "solr.shortLive": {"active":0,"free":0,"queued":0,"maxSockets":4}
  },
  "sockets_queued_total": 0,
  "admission": {
    "enabled": false,
    "heavy":       {"active":0,"max_concurrent":3,"depth":0,"max_queue":6,
                    "oldest_wait_ms":0,"admitted_total":0,"queued_total":0,
                    "rejected_queue_full_total":0,"rejected_timeout_total":0},
    "interactive": {...}
  }
}
```

**`agents.*.queued` is the number to watch.** Non-zero means requests are waiting for
sockets — the queue that was invisible before Phase 0.3 and that admission control exists
to keep empty.

Admission counters are **cumulative since process start**, so only deltas are meaningful
per run. `active_requests` is preserved at the top level because existing monitoring reads
it — it is a counter, not a gate.

**Verification harness:** `scripts/verify-protections.js <endpoint>` exercises a deployment
and reports which protections are present and working; `--expect-429` asserts shedding.
Run it after any deploy touching the query path — **twice this year a fully green offline
suite covered the wrong code path and the bug appeared only against a running server.**

---

## 7. Cross-cutting concerns worth knowing

**Permission filtering is row-level only.** `DecorateQuery` adds an `fq` deciding which
documents you see. Nothing decides which *fields* you may read, facet, or sort on — which
is why `owner`/`user_read` are bulk-enumerable (TODO-4, open). Any fetch that bypasses the
middleware chain — enrichment, cross-collection resolution, each join hop — must carry its
own permission context from `lib/permissionFilter.js`.

**A 200 is not success.** The characteristic failure here is a well-formed, successful-
looking response with truncated or missing content: the streaming-`sort()` trap, mid-stream
shard failure, the 8 KB shard-fetch ceiling. Assert on **exact row counts**, never on
"we got bytes."

**Facet counts cannot be corrected inside Solr.** `JoinEnrichment` is post-query and
page-scoped; `{!join}` filters but does not project; facets bypass the distributed path
entirely. Any overlay changing field values must correct counts arithmetically, API-side.

---

## 8. Where the remaining risk is

| gap | status |
|---|---|
| **Production is 183 commits behind** | has almost none of the above; still throwing `ERR_HTTP_HEADERS_SENT` from a months-fixed defect |
| Client `Retry-After` support | **gates enabling admission control**; nothing honours it yet. Contract specified in `Docs/CLIENT-429.md` |
| Layer 3 per-host admission | not implemented; latent while distributed query is off in production |
| Layer 4 Solr circuit breakers | cluster-side; now safe to enable |
| 4 serializers without backpressure | TODO-10 |
| Prewarm ungated | TODO-8 — 80 extra requests per distributed query on an 80-shard collection |

Sequencing: `Docs/COMPLETION_PLAN-2026-10.md`.

---

## Further reading

| document | subject |
|---|---|
| `CLAUDE.md` | operational reference, gotchas, debug namespaces |
| `PLAN_SOLR_OVERLOAD_PROTECTION.md` | the original four-layer plan (amended) |
| `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md` | corrections — `timeAllowed` does not work as the plan assumed |
| `Docs/ADMISSION_CONTROL_STATUS-2026-10.md` | why the admission queue is bounded rather than absent |
| `Docs/ADMISSION_CONTROL_MEASUREMENT-2026-10-16.md` | the measured A/B |
| `Docs/COMPLETION_PLAN-2026-10.md` | phase sequencing |
| `Docs/CLIENT-429.md` | **the client contract for 429s** — normative for CLI, website, P3DataAPI |
| `Docs/TODO.md` | open items |
