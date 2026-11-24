# Spec: `sample-solr-jvm` — JVM/GC sampler for Solr load-test windows

**Date:** 2026-10-16
**Status:** specification only — not implemented in this repo
**Intended home:** the separate Solr tooling repository, not BV-BRC-API
**Consumer:** before/after comparison of the API-side admission control shipped in
PR #231 (Phase 2 of `Docs/COMPLETION_PLAN-2026-10.md`)

---

## Purpose

Capture JVM heap and GC behavior across SolrCloud data nodes during a bounded load-test
window, at a resolution that makes **heap floor** and **old-gen GC pressure** visible.

## Background — why these metrics

The failure being guarded against is **JVM heap OOM**, not network or CPU. On 2026-06-25
three data nodes died simultaneously: cross-collection join queries over broad taxa
(`taxon_lineage_ids:2`, all Bacteria) materialized 57–93M-document DocSets per shard and
held them for the life of the query — measured up to 330 s. Concurrent sessions multiplied
the pressure until the heap was exhausted.

Two consequences for instrumentation:

- **Average heap-used is the wrong statistic.** What kills a node is the *floor* — heap
  that survives collection. A query holding a large DocSet raises the floor for its entire
  duration; peak-during-query is mostly young-gen churn and is noise here.
- **Resolution matters.** Ganglia's 1-minute averaging smooths away precisely the signal.
  This project has already been misled once by a coarse view; the record in
  `Docs/HANG-INVESTIGATION-2026-08-24.md` notes *"Do not diagnose from a one-hour window."*
  Target 5 s sampling.

## Scope

- **Read-only.** `GET /solr/admin/metrics` only. No cluster mutations, no collection
  operations.
- **Bounded run.** Samples for a fixed duration or until interrupted; not a daemon.
- **Per-JVM, aggregated per host.** Several nodes here run 19–21 JVMs on one machine
  (arborvitae 21, balsam 19). Per-JVM numbers are what Solr reports; **per-host rollup is
  what matters**, because that is the unit that runs out of memory. Report both.

## Inputs

```
sample-solr-jvm --zk <host:port> [options]
sample-solr-jvm --nodes <file-or-comma-list> [options]

  --duration <s>        sample window (default 300)
  --interval <s>        sample period (default 5)
  --out <file.jsonl>    raw samples (default stdout)
  --summary             per-node and per-host rollup at exit
  --label <text>        tag written into every record, e.g. "admission-on"
  --collections <list>  restrict core metrics to these (default: genome_feature,genome)
```

Node discovery should prefer **CLUSTERSTATUS**
(`/solr/admin/collections?action=CLUSTERSTATUS`) and derive the live replica base URLs,
rather than a static host list — `scripts/check-shard-consistency.js` in the BV-BRC-API
repo does exactly this and is a reasonable model. Accept an explicit node list as a
fallback for when ZK is unavailable.

## Metrics to collect

Endpoint per node: `GET <baseUrl>/admin/metrics?group=jvm&group=core&wt=json`

### JVM group — the primary signal

| field | source key | type |
|---|---|---|
| `heap_used_bytes` | `memory.heap.used` | gauge |
| `heap_max_bytes` | `memory.heap.max` | gauge |
| `heap_committed_bytes` | `memory.heap.committed` | gauge |
| `gc_young_count` | `gc.G1-Young-Generation.count` | monotonic counter |
| `gc_young_time_ms` | `gc.G1-Young-Generation.time` | monotonic counter |
| `gc_old_count` | `gc.G1-Old-Generation.count` | monotonic counter |
| `gc_old_time_ms` | `gc.G1-Old-Generation.time` | monotonic counter |

Collector names are **G1-specific**. Verify against the deployment (Solr 9.6.1); if a
different collector is configured the keys differ (`gc.PS-MarkSweep.*`, `gc.ZGC.*`). The
tool should discover whatever `gc.*` keys exist rather than hardcoding, and record the
collector name.

Counters must be emitted **raw**, with deltas computed at analysis time — a restart
mid-window otherwise produces a negative delta that silently corrupts a rate.

### Core group — the workstream-specific signal

Per core matching `--collections`:

| field | source key |
|---|---|
| `filtercache_evictions` | `CACHE.searcher.filterCache.evictions` |
| `filtercache_hitratio` | `CACHE.searcher.filterCache.hitratio` |
| `filtercache_size` | `CACHE.searcher.filterCache.size` |
| `requests` | `QUERY./select.requests` |
| `request_times_p95_ms` | `QUERY./select.requestTimes.p95_ms` |
| `errors` | `QUERY./select.errors` |
| `timeouts` | `QUERY./select.timeouts` |

**Why filterCache specifically:** the API now rewrites small cross-collection joins into
`{!terms f=genome_id cache=false}` filters carrying up to 50,000 ids. The `cache=false` is
deliberate and load-bearing — a cached terms filter measured 3,952 ms against 676 ms
uncached on a query with a co-occurring clause. If evictions climb during a rewrite-heavy
window, that reasoning is wrong in practice and the threshold needs revisiting. No generic
JVM dashboard will surface this.

## Output format

JSONL, one record per node per sample:

```json
{"ts":"2026-10-16T17:31:45.012Z","label":"admission-on","node":"bio-gp2.cels.anl.gov:8983",
 "host":"bio-gp2.cels.anl.gov","heap_used_bytes":8123456789,"heap_max_bytes":17179869184,
 "gc_old_count":12,"gc_old_time_ms":3401,"gc_young_count":8841,"gc_young_time_ms":119204,
 "cores":{"genome_feature_shard17_replica_n3":{"filtercache_evictions":0,"requests":41822}}}
```

Flat, greppable, and joinable to the API-side `/stats` samples by timestamp.

## Summary output

At exit, per node **and** per host:

- **heap floor** — the minimum `heap_used_bytes` observed in the window. This is the
  headline number. A floor that rises during load and does not return afterward is the OOM
  precursor.
- heap peak, and peak as a percentage of `heap_max`
- **old-gen GC time per second** — `Δgc_old_time_ms / Δwall_ms`. Sustained values above a
  few percent mean the node is spending real time in old-gen collection.
- old-gen collection count in the window
- filterCache evictions delta per core

Per-host rollup sums heap across that host's JVMs and reports it against physical RAM if
available — 21 JVMs each comfortable can still exhaust the machine.

## Validation the tool should do on itself

Three failure modes that would otherwise produce confident, wrong output:

1. **Counter resets.** A JVM restart mid-window makes a monotonic counter go backwards.
   Detect and mark that interval rather than reporting a negative or wrapped rate.
2. **Missing nodes.** If a node stops answering mid-window, record the gap explicitly. A
   node that went unreachable is itself the finding; silently dropping it turns an incident
   into clean-looking data.
3. **Collector mismatch.** If no `gc.*` keys match the expected collector, fail loudly at
   startup rather than reporting zeros for the entire run.

## Intended usage

```bash
# baseline, admission disabled
sample-solr-jvm --zk zk1:2181 --duration 300 --label admission-off --out off.jsonl --summary &
# ... run the API-side load test ...

# same load, admission enabled
sample-solr-jvm --zk zk1:2181 --duration 300 --label admission-on --out on.jsonl --summary &
```

The comparison that matters is **heap floor and old-gen GC time**, off vs on, under
identical offered load.

On the API side the generator is `scripts/verify-protections.js --expect-429 --concurrency 40`
in the BV-BRC-API repo. A measured run with admission enabled (2026-10-16T17:31–17:35Z,
pool 3 slots / 6 queue / 10 s) showed Solr receiving only **3 concurrent queries out of 40
offered** — 25 admitted over the window, 15 shed with 429 before reaching Solr. The expected
result is therefore a visibly lower heap floor in the `admission-on` window.

## Deliberate non-goals

- Not a dashboard or a daemon. Prometheus/JMX with retention is the better long-term
  answer; this is for bounded experiments.
- No alerting or thresholds. It reports; a human compares two windows.
- Doesn't touch CPU or network — those are already covered by Ganglia and, at 10GbE, are
  not the constraint here. Measured during a 40-request burst: peak ~95 MB/s on the API
  host, under 10% of line rate, and data nodes at 10–30 MB/s (~1–2%).

## One caveat worth passing on

If the cluster already has a JMX exporter or Prometheus scraping Solr, **use that instead**
— it has retention, and a one-shot sampler does not. This spec assumes it does not, which
is worth confirming before building anything.

---

## Context for whoever implements this

Relevant history, all in the BV-BRC-API repo:

- `PLAN_SOLR_OVERLOAD_PROTECTION.md` — the original four-layer plan, including the
  2026-06-25 crash analysis.
- `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md` — corrections after re-measurement; in
  particular `timeAllowed` does **not** cap DocSet lifetime, and the genome counts the
  original thresholds were based on have roughly doubled.
- `Docs/ADMISSION_CONTROL_STATUS-2026-10.md` — what admission control does and does not
  do, and why the queue is bounded rather than absent.
- `Docs/COMPLETION_PLAN-2026-10.md` — phase sequencing and current state.
