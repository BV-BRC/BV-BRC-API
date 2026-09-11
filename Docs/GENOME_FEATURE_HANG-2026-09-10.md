# `genome_feature` / `pathway` 120 s hangs — on-prem handoff

**Date:** 2026-09-10
**Reported as:** `summary_by_taxon` 500s
**Status:** **RESOLVED 2026-09-11** — wedged coordinator found on-prem, countermeasures in
place, fix verified externally (see "Resolution" below). One *separate*, still-open scaling
failure was uncovered underneath it: large-taxon joins. Tracked in `Docs/TODO.md`.
**Investigated from:** off-site (no ssh to `elm`, walnut/chestnut:15783 unreachable)

---

## Resolution (2026-09-11)

The team identified a **wedged Solr coordinator** and deployed countermeasures. Re-verified
from off-site; the intermittent 120 s hang is gone.

| probe (uncached) | 2026-09-10 | 2026-09-11 |
|---|---|---|
| `genome_feature` `q=*:*&rows=0` ×8 | ~40% success | **8/8 200**, QTime 3932–5685 ms |
| `pathway` `q=*:*&rows=0` ×8 | ~50% success | **8/8 200** |
| join+facet, taxon 562, ×6 | intermittent 120 s | **6/6 200**, QTime 7805–10092 ms |

Zero 120 s timeouts across 22 uncached trials. `pathway` improved dramatically: after a 9.7 s
warm-up it settles to **QTime 4–49 ms**. Both originally reported endpoints
(`summary_by_taxon/562`, `/1929297`) return 200.

The `replica.base:random` vs PULL/TLOG correlation recorded below was **circumstantial** — the
actual cause was the coordinator, not replica-type routing. Left in place as a record of the
reasoning, but do not treat that correlation as a finding.

### Still failing after the fix — a different, deterministic bug

Taxon **10239 (Viruses)** still returns 500 at 120 s, 4/4, and 3/3 even with the facet removed.
This is not the wedge. Join cost scales with the number of joined genomes:

| taxon | genomes matched | join result |
|---|---|---|
| 1929297 | 7 | 200, QTime 2593 ms |
| 1773 | 46,764 | 200, QTime 4172 ms |
| 562 | 119,464 | 200, QTime 9162 ms |
| 2 (Bacteria) | 1,382,169 | 200, **QTime 73699 ms** |
| 10239 (Viruses) | 15,564,398 | **500, 120 s timeout** |

Deterministic and load-independent — the crossCollection join must materialize a 15.5 M-genome
ID set. Previously hidden inside the intermittent noise. Top-of-taxonomy pages are still broken
(Viruses) or unacceptably slow (Bacteria at 74 s). Tracked as TODO-1.

---

## Symptom

```
$ curl https://www.bv-brc.org/api-for-website/data/summary_by_taxon/562
{"status":500,"message":"Cannot read properties of undefined (reading 'facet_fields')"}
```

Returns after ~120 s. The TypeError is cosmetic: `routes/dataRouter.js:64` dereferences
`results.facet_counts.facet_fields` unguarded, so a Solr timeout body gets `JSON.parse`d by
`subQuery()` (`dataRouter.js:20-34`) and then blows up. The real error underneath is:

```
Unable to request the database. Error: Solr request timed out after 120000ms
```

Same unguarded dereference of `results.response.numFound` at lines 77 and 91.

## The actual defect

**A bare `q=*:*&rows=0` count against `genome_feature` fails ~50–60% of the time**, hanging
exactly 120 s. No join and no facet are needed to reproduce.

Per-collection, 4–6 trials each, `POST` with `Content-Type: application/solrquery+x-www-form-urlencoded`:

| collection | result | numFound |
|---|---|---|
| `genome_feature` | **~60% 500s** (83% in one later run) | 8.0–9.0 B |
| `pathway` | **~50% 500s** | 1.84 B |
| `subsystem` | 4/4 OK | 1.93 B |
| `genome` | OK (QTime 839 ms) | 17 M |
| `taxonomy`, `protein_structure`, `strain` | all OK | — |

Reproducer:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -m 125 -X POST 'https://www.bv-brc.org/api-for-website/genome_feature/' \
    -H 'Content-Type: application/solrquery+x-www-form-urlencoded' \
    -H 'Accept: application/solr+json' \
    --data-binary 'q=*:*&rows=0' -o /dev/null -w '%{http_code} '
done; echo
# observed: 200 500 500 200 500 500
```

## Leading hypothesis — note this inverted mid-investigation

My first guess was the three collections carrying
`shards.preference: replica.type:PULL,replica.type:TLOG` in `config.js:146-156`.
**Production does not use those defaults.** Params actually echoed back by prod:

- `genome_feature` → `replica.base:random` ← **failing**
- `pathway` → `replica.base:random` ← **failing**
- `subsystem` → `replica.type:PULL,replica.type:TLOG` ← **healthy**

The correlation is the reverse of the initial guess: the two collections on
`replica.base:random` fail; the one pinned to PULL/TLOG is healthy. `subsystem` holds
1.93 B docs — *more* than `pathway`'s 1.84 B — so document scale is not the discriminator.

That points at `replica.base:random` routing into replicas that a PULL/TLOG preference
excludes, i.e. **NRT leaders**. A hung or GC-thrashing NRT leader accepts the connection and
never answers, while PULL/TLOG-preferring traffic routes around it.

Prod's `p3api.conf` overrides `config.js` for this setting — read the real one to confirm the
mapping before acting on it.

### Why "no replication errors, no downed instances" is consistent with this

A replica that accepts TCP and never responds stays ACTIVE in CLUSTERSTATUS and produces no
replication error. Aggregate cluster health looks clean. This requires per-replica probing.

## Ruled out — do not re-run

- **The crossCollection join is not the problem.** QTime 5750 ms with the join vs 5530 ms
  without — the join costs ~200 ms.
- **The facet is not the problem.** It adds ~4 s, and `facet.query` (11445 ms) is *worse* than
  `facet.field` (9661 ms). Do not "optimize" by switching facet style.
- **Redis caching works.** 0.26 s → 0.19 s on repeat, `apicache-store: redis`,
  `cache-control: max-age=83821`. But `onlyStatus200` means failures never cache, so every
  request during a bad spell pays the full 120 s. For 562 I saw three consecutive 120 s
  failures, then a success at 10.8 s that finally populated the cache.
- **Solr does not warm across repeats.** Identical query 3× in a row still QTime 6858 ms.
- **~5.5 s is the floor for any `genome_feature` query** (8 B docs). Expected, not a bug.
  For contrast `genome` (17 M docs) answers the same trivial query in 839 ms.

Timing table, retried past the intermittent failures until a 200 (Solr's own `QTime`):

| variant | QTime |
|---|---|
| `q=*:*&rows=0` (trivial, no join, no facet) | 5530 ms |
| join only, no facet | 5750 ms |
| join + `facet.field` | 9661 ms |
| no join + `facet.field` | 10065 ms |
| join + `facet.query` ×2 | 11445 ms |

## Could not test from outside

- **`shards.*` overrides return 400.** `middleware/SolrQuerySanitizer.js` blocks them
  (`DANGEROUS_PARAMS` + `SHARDS_PREFIX_PATTERN`). Testing a preference override requires
  bypassing the API or editing config.
- **`timeAllowed=8000` has no effect on the hang.** 6 trials: one 200 at 5.79 s
  (`numFound: 8954910478`, no `partialResults` flag), five 500s at 120.13–120.26 s. A query
  explicitly told to give up at 8 s still hangs for the full 120.

  This is diagnostic. `timeAllowed` bounds work *inside* a searcher, so if it never fires the
  request is stuck **before any shard begins searching** — connection accepted, never
  dispatched. That favors a wedged JVM over a slow query. Confirm on-prem whether the param
  reaches Solr at all or is genuinely ignored on the hung path.
- **`genome_feature` numFound varied across runs:** 8034868345 / 8954910478 / 7816033017
  (last from the no-join facet variant). Could be active indexing; could be shards silently
  dropping out. **Worth checking whether successful responses are actually complete** — silent
  partial results would be the more alarming finding, and it matches the
  empty-200-on-shard-failure defect already recorded in the query-replay work.

## First three things to do on-prem

1. `CLUSTERSTATUS` for `genome_feature` and `pathway` — enumerate replicas by type
   (NRT / TLOG / PULL) and node, then hit **each replica directly** with
   `q=*:*&rows=0&distrib=false` and a short timeout. Hung ones stand out immediately.
2. On any replica that hangs: thread dump + GC log. Expect a stuck merge/searcher-warm or a
   full-GC death spiral.
3. Compare `subsystem`'s replica placement against the other two — it is the control case at
   the same document scale.

## Related prior work

`Docs/HANG-INVESTIGATION-2026-08-24.md` is referenced in project memory but **is not in this
working tree** (`Docs/` holds only `ALPHA_TO_MASTER_MERGE_RISK.md` and `API-tutorial.md`) —
it lives on branch `feature/eliminate-self-call`. Retrieve it before re-diagnosing. It records
the same byte-exact 120 s signature from August 2026 and lists theories already killed,
including two of mine that tested false:

- `maxFreeSockets: 0` does **not** disable pooling — Node treats `0` as unset.
- Proxy bandwidth spikes look damning in a 1-hour Ganglia view and are routine in the full-day
  view. Do not diagnose from a one-hour window.

It also documents two verified defects that independently produce this symptom: socket timeouts
don't bound agent queue time, and `util/http.js` has no timeout mechanism at all.

## The TypeError — already fixed on `alpha`, plus a 504 follow-up

The masking `TypeError` was diagnosed against `master`, where `dataRouter.js` still self-calls
over HTTP via `util/http.js` and dereferences the parsed body unguarded.

**`alpha` had already fixed it**, more completely, as part of the self-call elimination work:
`dataRouter` now calls `internalQuery` in-process, routes failures through `failSubQuery()`,
and uses `.catch()` rather than `.then(ok, fail)` — deliberately, because the two-argument form
does not catch a throw from inside the success handler, which is exactly this bug. A separate
fix written against `master` was therefore **discarded rather than ported**: alpha's version
also closes the unhandled-rejection hazard, which under `--unhandled-rejections=strict` takes
the process down.

One real gap remained, and is what this branch fixes. A Solr **timeout** rejection originates
in `armTimeout()` (`lib/solrjs/index.js`) as a bare `Error` with **no `statusCode`**, so
`failSubQuery`'s `err.statusCode >= 400` test fell through to **500** — reporting upstream
unresponsiveness as a fault in this service. Now:

- `lib/internalQuery.js` classifies a timeout rejection as **504** (message-matched on
  `/timed out/i`, only when `statusCode` is not already set).
- `failSubQuery` gives 504 a distinct message, `'The database did not respond in time'`,
  rather than the generic database error.

Verified end-to-end against a **black-hole server** — one that accepts the connection and never
responds, reproducing the production failure mode exactly:

```
elapsed_ms : 1508
message    : Unable to request the database. Error: Solr request timed out after 1500ms
statusCode : 504
```

Regression-checked that the other paths are untouched: a Solr in-body error still yields 400,
and a connection refusal stays unclassified (→ 500) rather than being mislabelled a timeout.
`node --check` and `npx eslint` clean on both files.

## Dead end worth recording

`genome` already carries `cds` and `mat_peptide` fields, and
`json.facet={CDS:"sum(cds)"}` answers in **0.3 s** with no join — but the numbers do not match
the join. For 562: join `CDS: 1,053,060,095` vs `sum(cds): 637,262,972`. For 1929297: 37,105 vs
22,672. So it is not a drop-in replacement; `genome.cds` appears stale or differently defined.
Separate investigation if anyone wants the fast path.
