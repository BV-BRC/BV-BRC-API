# feature/distributed-query — Branch Risk Analysis & Crash-Report Commentary

**Date:** 2026-07-13 · **Branch:** `feature/distributed-query`
**Compare target:** `upstream/alpha` (NOT master — see below)

This document captures a review of what `feature/distributed-query` changes
relative to the upstream branches, focused on **risk of altering the behavior /
performance of the preexisting API** (as opposed to net-new API surface), plus
commentary relating the July 9 chestnut coordinator crash to this work and the
admission-control plans.

---

## Critical framing: compare against alpha, not the merge-base

The git merge-base of this branch (`223a99d3`) is **stale** — it predates several
PRs that have since landed in `upstream/alpha` (notably **PR #176**, the IDOR fix,
and the other Synack security fixes: SSRF recursive-decode in
`SolrQuerySanitizer`, JBrowse sanitization, numeric-param validation).

Diffing against the merge-base therefore **over-counts** the delta: it shows
security fixes that are already in alpha as if this branch introduced them. The
correct comparison is `git diff upstream/alpha..HEAD`.

Confirmed already-in-alpha (identical content, NOT this branch's delta):
- `middleware/SolrQuerySanitizer.js` — same as alpha
- `routes/JBrowse.js` — same as alpha
- `middleware/APIMethodHandler.js` getSOLR IDOR multi-doc permission filter — byte-identical to alpha (PR #176)

**Also note:** against `upstream/master` the picture is entirely different —
`DistributedQuery`, `JoinFieldInjector`, `JoinEnrichment`, and
`JoinEnrichmentStream` do **not exist in master at all**. Merging this branch to
master would deliver the whole distributed-query + join-enrichment subsystem at
once, a far larger and riskier change than the alpha merge. If master is ever the
target, that subsystem — not the GenBank/download work — is the real risk surface.

---

## True code delta vs. `upstream/alpha` (js, excluding tests/scripts)

```
 lib/distributed/JoinEnrichmentStream.js | 160 ++++++   (new file)
 lib/solrjs/index.js                     |  11 +        (opt-in timeout)
 lib/solrjs/rql.js                       |  18 +        (terms() operator)
 media/dna+fasta.js                      |  17 +-       (genome_sequence FASTA header)
 media/genbank.js                        | 845 +++----- (leaf serializer rewrite)
 media/gff.js                            |   1 +        (contentTypeAliases)
 media/index.js                          |   6 +        (alias registration)
 middleware/APIMethodHandler.js          |  22 +-       (stream join-enrichment hook)
 middleware/DistributedQuery.js          |  31 +-       (join hook + get-by-id fix)
 middleware/JoinFieldInjector.js         |  43 +-       (buildJoinSpecs)
 routes/dataType.js                      |  20 +        (GenBank /genome/ guard)
```

---

## Risk tiers (by blast radius on the preexisting API)

### 🔴 Tier 1 — Shared-path behavior change (the one real remaining risk)

**Streaming join-enrichment hook** — added in both `APIMethodHandler.streamQuery`
and `DistributedQuery` (commit `67cea0b0`).

- **What:** when `req._joinSpecs` is set, pipe the result stream through the new
  `JoinEnrichmentStream` (batches docs, calls `getJoiner()`, does secondary Solr
  lookups to enrich joined fields inline).
- **Blast radius:** every **streaming download that requests a joinable field**
  (e.g. `genome_name` on a `genome_feature` download). This is a common, existing
  query shape — not niche.
- **Risk:** inserts a new Transform stream into the middle of a mainstream
  download pipeline. A batching bug, stall, or leak degrades that path.
- **Guard:** gated by `req._joinSpecs` — downloads not requesting joined fields
  are byte-identical to alpha. Setup is `try/catch` → falls back to unenriched.
- **Gap:** the `try/catch` only covers **setup**. An error *during* streaming (a
  join lookup hanging, a backpressure bug in the Transform) is NOT covered and
  would affect the live download.
- `JoinEnrichmentStream.js` is new to alpha via this branch — not yet
  battle-tested on the shared path. Its correctness under backpressure/error is
  the thing to test before merge.

**Recommended before merge:** (a) tests for `JoinEnrichmentStream` on the
streaming path; (b) harden in-stream error handling so a mid-stream join failure
degrades to unenriched output instead of breaking the download.

### 🟡 Tier 2 — Low risk, scoped

- **`DistributedQuery` get-by-ID fix** (`22c08724`) — moves the `call_method`
  check before query-string parsing; prevents a crash when `call_params[0]` is an
  ID array. Net-positive, behavior-preserving for query/stream.
- **`JoinFieldInjector.buildJoinSpecs`** — additive; computes & stashes
  `req._joinSpecs`. Existing fl-injection unchanged.
- **`rql.js terms()` operator** — additive; only affects queries using `terms()`.
- **`dataType.js` GenBank guard** (`1541be98`) — early 400, condition is
  `isDownload && accept===application/genbank && collection!==genome`. Cannot
  affect non-GenBank requests.

### 🟢 Tier 3 — New / isolated (near-zero risk to existing API)

- **`media/genbank.js`** (845 lines) — leaf serializer, `application/genbank`
  only. Largest diff, safest change.
- **`lib/distributed/JoinEnrichmentStream.js`** — new file, reachable only via the
  Tier-1 hook.
- **`lib/solrjs/index.js`** — request timeout is **opt-in** (`this.timeout` /
  `options.timeout`), unset for all existing callers → byte-identical unless set.
  Only GenBank sets it.
- **`media/gff.js`, `media/index.js`, `dna+fasta.js`** — additive alias /
  formatting.

---

## Bottom line

The genuine risk to existing API behavior/performance in this branch, **when
merged to alpha**, is essentially **one item: the streaming join-enrichment hook**
(and the newness of `JoinEnrichmentStream` on the shared path). Everything else is
additive, guard-gated, a leaf serializer, or already-in-alpha.

An earlier pass mistakenly flagged the IDOR fix and the SSRF sanitizer as this
branch's highest risks — that was an artifact of diffing the stale merge-base;
both are already in alpha (PR #176 et al.) and are not deltas here.

---

## Relation to the July 9 chestnut crash & admission controls

See `crash-report-chestnut-2026-07-09.md`. Root cause: coordinator JVM
Full-GC freeze → ZooKeeper session expiry, driven by **cross-collection join
aggregation** of huge DocSets for broad taxons (`taxon_lineage_ids:10239`
Viruses, `2697049` SARS-CoV-2, `11118` Coronaviridae, `197911` influenza — all
always time out at 600s).

**This branch neither caused nor prevents that crash** — it's a separate
workstream (the Solr cross-collection *query* joins, not API-side field
enrichment; don't conflate the two). Where the work connects:

1. **`solrjs` now has a request-timeout primitive** (`5bdf4044`, currently wired
   only into GenBank via `GENBANK_SOLR_TIMEOUT_MS`). This is the natural hook for
   a general `timeAllowed` / client-timeout layer the crash report's Prevention
   item #2 (`canCancel` + disconnect handling) wants. Half the plumbing exists;
   it is not yet applied to the main query path.
2. **The GenBank `/genome/` guard** (`1541be98`) is a working template for
   Prevention item #1 (block always-timeout taxons at p3api with a 400 before
   Solr). The taxon block-list would be a sibling guard in the same
   `routes/dataType.js` chain.
3. **Reinforces the overload-protection priority.** Removing the GenBank stall
   removed an *accidental* rate limiter (see `GENBANK_DOWNLOAD_PERFORMANCE.md`);
   the crash is the same lesson at the query layer — broad joins have no admission
   control. Both point at `PLAN_SOLR_OVERLOAD_PROTECTION.md`.

### Suggested next admission-control steps (not yet done)

- Taxon block-list guard in `routes/dataType.js` (siblings the GenBank guard):
  reject `taxon_lineage_ids` in {10239, 2697049, 11118, 197911, and review 2, 286}
  with a 400 pointing to the download service.
- Extend the `solrjs` timeout to the main query path (`timeAllowed` +/or
  client-disconnect cancellation via Solr 9.x Task Management API).
- Solr-side (not p3api): CircuitBreakerPlugin on coordinators (503 on heap
  pressure), GC logging on chestnut, coordinator heap/G1 tuning, alerts on ZK
  session loss and QTime>120s.
