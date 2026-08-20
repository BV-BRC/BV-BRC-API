# Query-Replay Analysis — Handoff

**Context for continuing on the on-prem system.** Written 2026-07-16 from a laptop
session; the analysis must move on-prem because distributed query needs direct
data-node network access (see "Why on-prem" below).

## Goal

Replay real-world saved query logs against the dev data API to look for anomalies,
with emphasis on the `feature/distributed-query` branch's distributed-query path.

## Tooling

- **Replay script:** `../bvbrc_website/scripts/replay-queries.js`
  ```
  node scripts/replay-queries.js <log.jsonl> <api-endpoint> [options]
  ```
  Options: `--token <tok>`, `--concurrency <n>`, `--timeout <ms>`, `--fail-only`,
  `--summary`, `--output <file.jsonl>`, `--ignore-order`, `--max <n>`.
  Behavior: replays each logged request, deep-JSON-diffs replay vs recorded
  `response`, PASS = deep match AND same status. Skips entries that are
  `download`, have no `response`, or are `/jbrowse/*`. Ignores volatile fields
  (`QTime`, `NOW`, `appRid`, `response.maxScore` top-level, `shards.preference`).

- **Logs:** `../bvbrc_website/query-logs/*.jsonl` — one real analysis per file.
  Sample used: `olson@patricbrc.org-2026-07-15T19-33-46-308Z.jsonl` (47 lines,
  39 replayable). Genome under analysis: **573.14359**.

- **Distributed diagnostic endpoint** (returns per-shard status, not a stream):
  ```
  curl -s -X POST <endpoint>/test/distributed-query \
    -H 'Content-Type: application/json' \
    -d '{"collection":"genome_feature","query":"fq=genome_id:573.14359&rows=25000"}'
  ```

## Baseline replay result (laptop, over single-coordinator SSH tunnel)

`node scripts/replay-queries.js <sample> http://localhost:13001 --ignore-order --output /tmp/replay-baseline.jsonl`

**39 replayed: 21 pass / 15 fail / 3 error.** Breakdown:

| Category | Count | Verdict |
|---|---|---|
| distributed `genome_feature limit>=10000` returns empty `[` | 3 (errors) | **Real defect + env** (see below) |
| `_forwardedCount` extra param on subsystem | 5 | Env — SolrCloud forwarding param from dev topology |
| `params.fq` mismatch (`public:true` vs owner-filter) | 5 | Noise — replay ran unauthenticated; use `--token` |
| `maxScore` missing / float drift (nested / `response`-level) | 5 | Noise — volatile; ignore-list misses nested paths |

## Key finding #1 — environment limit (why on-prem)

Distributed query **bypasses the Solr coordinator** and connects directly to data
nodes by real hostname. The diagnostic endpoint returns:
```
Shard shard2 failed: Request failed: getaddrinfo ENOTFOUND bio-gp2.cels.anl.gov
```
A single-coordinator tunnel (`localhost:15183`) can't reach those. So every
distributed shard fetch fails DNS on the laptop.

Reproduction — the break is **exactly at `minLimitThreshold` (10000)** for
`genome_feature`:
```
limit=9999  -> 200, 658865 bytes  (standard coordinator path — correct)
limit=10001 -> 200, 1 byte "["    (distributed path — empty)
```
`excludeNodes` cannot fix this (you'd need to exclude all shards). **On-prem, with
data-node reachability, the distributed path should actually run** — that's the
environment needed to validate distributed correctness.

## Key finding #2 — real API defect (fix regardless of environment)

On a **mid-stream shard failure**, the distributed streaming path returns
**HTTP 200 with a truncated `[`** — a silent empty success, not an error or a
fallback. Trace:
- `lib/distributed/ParallelQueryCoordinator.js` handles shard error correctly:
  `stream.on('error')` -> `_failAll()` -> `this.destroy(err)` (fail-fast, emits
  stream `'error'`). MergeSortStream path (sorted queries) is analogous.
- But `middleware/DistributedQuery.js` (~line 248, `queryResult.stream.pipe(wrappedStream)`)
  has already sent `200` + `[` by the time that error fires, so status can't
  change and the response just truncates.
- Contrast: **setup-time** CLUSTERSTATUS failure DOES fall back cleanly
  (log: "Distributed query failed, falling back to standard query"). Only the
  **mid-stream** failure leaks an empty 200.

This is exactly the gap flagged in `CLAUDE.md` / `Docs/BRANCH_RISK_ANALYSIS.md`:
the streaming join-enrichment / distributed streaming hook's mid-stream errors
are unguarded and untested. Silent data loss (empty 200) is worse than an error.
NOTE: the empty-`[` reproduces even **without** a joinable field in `select()`, so
the fault is the distributed shard-failure handling itself, not `JoinEnrichmentStream`.

## Next steps (on-prem)

1. Re-run the baseline replay from a host with data-node network access; confirm
   the `genome_feature limit>=10000` queries now return full results.
2. Run **with `--token <valid-token>`** to eliminate the `params.fq` auth noise.
3. **A/B the distributed path**: replay the same log twice against the same API —
   once with `distributedQuery.enabled: true`, once `false` — and diff the two
   result sets. That isolates real distributed anomalies from dev/prod drift.
   (User had distributedQuery disabled at first this session; confirm it's enabled
   in `p3api.conf` and that TLS to Solr is configured — `distributedQuery` needs
   `rejectUnauthorized:false` or a `ca` for self-signed certs, else CLUSTERSTATUS
   fails and it silently falls back to standard.)
4. Decide on fixing defect #2: make a mid-stream distributed shard failure either
   (a) fail before headers are sent when possible, or (b) surface a clear
   error/incomplete signal to the client instead of a clean empty 200. Consider
   detecting first-byte-not-yet-sent to still allow status change / fallback.
5. Restart the API with stdout/stderr captured to a log file, and run with
   `DEBUG=p3api-server:distributed:*` to get per-shard/coordinator traces during
   replay (laptop session had no file logging).

## Env / config notes

- Dev API was on `http://localhost:13001` (laptop). Solr reached via SSH tunnel
  at `https://...@localhost:15183/solr` (coordinator only).
- `distributedQuery`: `enabled`, `enabledCollections:['genome_feature']`,
  `minLimitThreshold:10000`, `maxParallelism:8`, `cursorBatchSize:2000`.
- Branch: `feature/distributed-query`. Diff distributed subsystem vs
  `upstream/master` (net-new) or behavior-change vs `upstream/alpha` per
  `Docs/BRANCH_RISK_ANALYSIS.md`.
