# Broad-taxon join: the 258-second cold build

**Date:** 2026-10-23
**Reported as:** "the Influenza A Sequences tab times out in Safari but works in Chrome"
**Status:** **ROOT CAUSE FOUND.** Not a fault — the cold build of a broad-taxon
cross-collection join takes **258 s**, and every deadline in the stack is shorter.
**Verified:** direct Solr query, no API in the path, `HTTP 200` in 257.9 s.

---

## The finding in one table

| state | time |
|---|---|
| **cold build** (`{!join}` over 1.6 M genomes) | **257,898 ms** |
| **warm** (same query, DocSet cached) | **70–83 ms** |
| API deadline (`SOLR_REQUEST_TIMEOUT_MS`) | 120,000 ms |
| Cloudflare origin limit | ~100,000 ms |

The cold build is **2.1× the API deadline** and **2.6× Cloudflare's**. A cold request can
therefore *never* succeed through the website — it is cut off less than halfway. The page
works only when something recently warmed the DocSet, and warm it is **~3,700× faster**.

That single fact explains every symptom, and it is the only thing that needed explaining.
There is no incident, no sick host, no leak. Most of this investigation was spent ruling
out faults that were not there; §5 lists them so nobody repeats the work.

The proof, run on-prem to bypass the API's own timeout:

```
$ ./join-nodeadline.sh --direct walnut.cels.anl.gov:15383
-- POST https://walnut.cels.anl.gov:15383/solr/genome_sequence/select
   HTTP 200   wall 257.920138s
   Solr QTime : 257898 ms
   numFound   : 1,741,906
```

---

## 1. The query

Taxon **2955291 — *Alphainfluenzavirus influenzae*** (Influenza A), **species rank**,
**1,625,381 non-Deprecated genomes**. Issued by the website whenever the Sequences or
Features tab is opened on that taxon page.

```
GET /api-for-website/genome_sequence/
    ?eq(genome_id,*)
    &genome(and(eq(taxon_lineage_ids,2955291),ne(genome_status,Deprecated)))
    &limit(1)
    &facet((field,sequence_type),(field,sequence_status),(field,mol_type),
           (field,topology),(field,chromosome),(field,plasmid),(field,segment),
           (field,public),(mincount,1),(limit,100))
```

becomes, at Solr:

```
q=genome_id:*
fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}
     (taxon_lineage_ids:2955291 AND !genome_status:Deprecated)
fq=(public:true OR owner:… OR user_read:…)
facet=true  facet.limit=100  rows=1   (8 facet fields)
```

`limit(1)` is not the cost. The join must materialise the whole genome-id set regardless
of how many rows are returned.

**Size is a property of the taxon, not the rank.** The guard in `lib/joinResolver.js` was
calibrated on the assumption that "broad" means a high rank like Bacteria. It does not:

| taxon | | non-Deprecated genomes |
|---|---|---|
| 10239 | Viruses | 14,931,913 |
| 2697049 | SARS-CoV-2 (**species**) | 9,395,894 |
| **2955291** | **Influenza A (species)** | **1,625,381** |
| 2 | Bacteria | 1,316,755 |
| 562 | *E. coli* | 114,570 |
| 1773 | *M. tuberculosis* | 46,433 |

Influenza A and SARS-CoV-2 — two of the most-browsed pages on the site — are both *larger*
than all of Bacteria.

---

## 2. Why it looked like an intermittent fault

Warm/cold is binary, so the failure pattern is **blocky**, not random. A client-side probe
every ~60 s produced:

```
12:31  XXSXXXXXXX SSSXSSSSSSSS SSSSS XXXXX  13:19     S=ok X=fail
       ^^^^^^^^^^ fail run     ^^^^^^^^^^^ clean run  ^^^^^ fail run
```

12/22 success over the first window, 55%. Each apparent "transition" is just the DocSet
ageing out or being rebuilt. Consequences that wasted time:

- **"Safari fails, Chrome works"** — both were Chrome in the end. Safari's request went in
  cold; by the time Chrome was tried, something had warmed it. **No browser involvement.**
- **Spot measurements contradict each other.** The same URL measured 1,331 ms, 45 s,
  56.9 s, 70 ms and a 120 s timeout within one hour. Never conclude from one sample.
- **Two HAR captures 20 minutes apart** showed every *join* request degrading while every
  *non-join* request stayed fast — which looks like a cluster-wide event and is not:

| endpoint | join? | 16:58 UTC | 17:19 UTC |
|---|---|---|---|
| `genome/` ×4 | no | 297 / 807 / 3021 / 566 ms | 411 / 725 ms |
| `taxonomy`, `summary_by_taxon` | no | 63–75 ms | 0–141 ms |
| `genome_amr/` | **yes** | **277 ms** | **10,829 ms** |
| `genome_sequence/` ×2 | **yes** | **1331 / 983 ms** | **500 @ 120,061 ms** |

---

## 3. Cache behaviour, measured

The cached object is the **join DocSet keyed on the join `fq`**, not the whole query.
Varying the outer clause while holding the join constant stays fast (112–805 ms); changing
the join filter is a full cold build.

Warm-up caught live on the production pool:

```
rep1  200  56,669 ms   <- cold
rep2  200      73 ms
rep3  200      83 ms
rep4  200      70 ms
rep5  200      74 ms
```

And cold vs warm across taxa, same pool, same minute:

| taxon | | result |
|---|---|---|
| 11320 (Influenza A, old id) | cold | 500 @ 120 s |
| 197911 (Orthomyxoviridae) | cold | 500 @ 120 s |
| 2955291 (Influenza A) | **warm** | 200, QTime **27 ms** |

### A thundering-herd failure sits on top of this

Once the entry is gone, *every* request pays the 258 s build but is killed at 120 s — so
nothing repopulates it. Observed directly: an entry that answered in 27 ms at ~13:5x gave
**three consecutive 120 s timeouts** at 14:12 / 14:14 / 14:16. The page stays broken until
a request somehow survives long enough, which through the website it cannot.

### What ends a warm period is still unknown

**This is the one open question.** During a 118-second window in which the query timed out
twice, the `genome_sequence` filterCache showed:

- **0 evictions**
- **0 searcher resets**
- `size` peaking at **12** entries against a **512** ceiling (2% full)
- **98.5%** hit ratio

So neither LRU pressure nor searcher reopen was evicting it at that moment. Something else
ages it out. It does not change the fix, but it is unexplained.

---

## 4. The fix

**1. Rewrite the join as `{!terms f=taxon_id cache=false}` — recommended.**

Measured: **3.6 s** for the full 112,721-taxon subtree of Influenza A, against the join's
258 s cold. No cache dependency, so no cold cliff at all.

Correctness verified — the taxon-subtree and the lineage join match **exactly**:

```
via taxon_lineage_ids:2955291   1,949,521 genomes
via taxon_id in subtree         1,949,521 genomes
difference                              0   (0.000%)
```

Mechanics: fetch the descendant taxon ids from `taxonomy` (`lineage_ids:<taxon>`, ~1 s via
cursor paging), emit `{!terms f=taxon_id cache=false}`. The id list is **0.82 MB** for
112,721 taxa — deliverable, because shard pages are POSTs.

Two caveats that must be settled first:

- **It cannot express `ne(genome_status,Deprecated)`.** `genome_sequence` has no status
  field, so a bare `taxon_id` filter also returns Deprecated genomes. For this taxon that
  is **1,949,521 vs 1,625,381 — a 20% over-count**, and it would be silent: HTTP 200 with
  wrong numbers. Needs the denormalisation in §4.3, or restriction to purely taxonomic
  filters.
- **Resolve to `taxon_id`, never to `genome_id`.** The genome-id list for this taxon is
  ~20 MB, and `Limiter` caps the fetch at 50,000 so it cannot even see the full set.
  Also: `genome_id` is *usually* `<taxon_id>.<n>` but **not always** — 43 mismatches in a
  4,000-genome sample (1.1%), e.g. `1540896.3` with `taxon_id 2949581`. Do not derive
  membership from the id prefix.

**2. `newSearcher` warming queries** for the broad taxa (2, 10239, 2697049, 2955291).
Pays the 258 s in the background so no user meets it cold. Config-only, complementary to
(1), and it also covers `sp_gene` / `genome_amr` / `genome_feature`, which join too.

**3. Raising `SOLR_REQUEST_TIMEOUT_MS` does NOT work on its own.** Cloudflare still cuts at
~100 s, so users would get a 524 instead of a 500. Only useful alongside an async/SSE page.

**4. Denormalise `genome_status`** onto `genome_sequence` and `genome_feature`. This is
what makes (1) correct. Scope is much smaller than it first appears — with
*absent-means-not-deprecated*, only the deprecated subset needs writing:

| | |
|---|---|
| deprecated genomes | 769,008 (4.5% of 17,061,503) |
| …of which viral | 702,579 (91%), averaging **20 features** each |
| …of which bacterial | 65,412 (9%), averaging **6,470 features** each |
| **estimated feature docs to write** | **~444 M — 4.96% of 8.96 B** |

Note Influenza A holds **324,140 deprecated genomes — 42% of all deprecations** — but
contributes almost nothing to the write volume, because viral genomes are tiny.

Field type does not matter for query cost. Interleaved A/B on 287 M docs, `cache=false`:
boolean `-public:true` and string `-topology:circular` both **4 ms min / 5 ms median**.
Selectivity dominates; type does not register. Choose on semantics instead — a `deprecated`
boolean is honest about encoding one bit, whereas a `genome_status` string populated on
only one of five values is a trap for whoever next reads the schema.

---

## 5. Ruled out — do not re-investigate

Each tested and rejected during this session:

| theory | how it died |
|---|---|
| Safari vs Chrome | the failing HAR *is* Chrome |
| `q=*:*` vs `q=genome_id:*` | controlled A/B — both identical |
| hourly ingest | failures at 12:39 and 17:19, nowhere near the hour; the probe ran clean *through* the 13:00 ingest |
| OOM / GC | zero `OutOfMemoryError` across 34 coordinator + 97 data-node instances |
| commits / searcher reopens | zero in-window on every instance |
| replica recovery / leader election | zero |
| wedged coordinator | the slow work is on the shards; the coordinator is merely waiting |
| sick backend in the pool | all four behaved identically — **note that test was itself invalid**, see below |
| concurrent slow joins | 17/32 correlation at both 10 s and 2 s thresholds, with 9+ failures while coordinators were idle |
| filterCache LRU pressure | `genome_sequence` peaks at 12/512 entries, 98.5% hit |
| searcher reopen evicting it | 0 resets during a window containing two timeouts |
| system contention | cluster network ~4 MB/s — idle — and the query still failed |

### Measurement traps that produced false conclusions

Recorded because each one cost an hour.

- **A bare TCP connect succeeds against a TLS listener.** A `/dev/tcp` reachability check
  reported "OK" for ports that only speak HTTPS; the subsequent plaintext queries then hung
  until the client's own deadline. The tell was that all 20 requests returned `http=000` at
  *exactly* 130 s, the `-m` value, identical across 4 hosts × 5 reps. Real slowness varies;
  exactly-at-timeout ×N is a protocol mismatch.
- **`curl --netrc-file` matches by hostname.** Requesting `127.0.0.1` does not match an
  entry for `balsam.cels.anl.gov`, so curl sends nothing and Solr returns 401. Use the FQDN
  — or add a `127.0.0.1` entry to the netrc.
- **The two API paths are different machines.** `/api-for-website/` → coordinators
  `c_03`, `c_06`; `/api/` → `c_01, c_02, c_04, c_05, c_08, c_09`. In the window studied the
  production pool carried **814** joins and the other pool **2**. Probing `/api/` and
  comparing against logs from the production pool is not a valid comparison, and invalidated
  one whole round of correlation analysis.
- **Solr listeners span `15<NN>83` *and* `16<NN>83`.** Guessing only the first range found
  nothing on all nine data nodes.
- **Coordinator cores hold no index.** A `filterCache` dump from a coordinator shows 39
  `COORDINATOR-COLL-*_set` cores with every counter — cumulative included — at zero. The
  join DocSet is cached on the **data** nodes.

---

## 6. Collateral findings worth acting on

**`genome_feature`'s filterCache is badly undersized.** Independent of everything above:

| | |
|---|---|
| cores | 184 |
| pinned at `size=512` | **151 (82%)** |
| cumulative evictions | **626,842,974** |
| resident | **107.8 GB** |
| worst core | `shard53.replica_t445` — 15.3 M evictions, 33.6 M lookups |

Compare `genome_sequence`: 37 cores, max size 12, 98.5% hit. The two collections are in
completely different regimes on the same hardware.

**`/data/summary_by_taxon/10239` is pure waste.** `routes/dataRouter.js:139` joins
`genome_feature` to taxon 10239 (Viruses, 14.9 M genomes). Three instances in a 75-minute
window, each **600 s**, each ending `status=500` — ~30 minutes of coordinator time for
nothing. `lib/joinResolver.js` on alpha already rejects this with a fast 400; that is an
argument for landing **PR #239** on master.

**Broad-taxon joins are organic load, not a crawler.** 29 slow joins (>10 s) in the window,
**29 distinct `appRid`s, zero repeats** — 25 from `plum-web`, 4 from `p3api`. There is no
single client to throttle. By taxon: Bacteria 14, *Escherichia* 5, Viruses 4, *Pseudomonas*
3, Coronaviridae 2. By target: `sp_gene` 10, `genome_feature` 8, `genome_amr` 6,
`genome_sequence` 4, `subsystem` 1 — **every tab on a broad taxon page**, not just Sequences.

**Influenza A never appeared in the slow-join logs.** The page that prompted this
investigation is a victim of the general problem, not a cause of it.

---

## 7. Tools written for this investigation

In `$CLAUDE_JOB_DIR/tmp` and copied to `~/Downloads`. None are committed; they are recorded
here so they can be rebuilt.

| script | purpose |
|---|---|
| `scan-solr-logs.sh` | per-instance log scan over `/solr/cluster/[ic]_*/logs`; errors, commits, recovery, joins, GC, by minute |
| `slow-joins.sh` | full untruncated params of joins over a QTime threshold; taxon / collection / `appRid` tallies |
| `probe-coordinators.sh` | direct per-coordinator probe, HTTPS + netrc, to test for a sick backend |
| `cache-stats.sh` | `filterCache` stats from data-node cores, with port autodiscovery |
| `probe-cache-decay.py` | measures how long a warm join survives; `--pressure` tests the LRU hypothesis |
| `join-nodeadline.sh` | **the one that settled it** — runs the join with no deadline; `--direct` bypasses the API |

`appRid` is the field that ties a slow Solr query back to the p3_api access log, and thence
to a client — `middleware/Limiter.js` sets it on every API query.
