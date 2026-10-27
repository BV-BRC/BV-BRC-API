# Procedure: resize `genome_feature`'s filterCache

**Why:** measured 2026-10-23 across all nine data nodes — `genome_feature`'s filterCache
is saturated, and `genome_sequence`'s is nearly empty. The two collections share hardware
but are in completely different regimes.

| | `genome_feature` | `genome_sequence` |
|---|---|---|
| cores | 184 | 37 |
| **pinned at `size=512`** | **151 (82%)** | 0 |
| max `size` observed | 512 (the ceiling) | **12** |
| cumulative evictions | **626,842,974** | 2,217,029 |
| avg hit ratio | 93.9% | 98.5% |
| resident | **107.8 GB** | 2.0 GB |

Worst single core: `genome_feature.shard53.replica_t445` — **15,353,139 evictions**,
33,587,963 lookups, 612 MB.

**What this will and will not fix.** It will reduce eviction churn on the busiest
collection. It will **not** fix the Influenza A Sequences tab — that is a 258 s cold join
build on `genome_sequence`, whose cache is 2% full and had **zero** evictions during a
window in which the query timed out twice. Do not expect the two to be related; see
`Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md`.

---

## 0. Before you start

Heap headroom is the binding constraint, not disk. `genome_feature` already holds
**107.8 GB** of filterCache across 184 cores (~590 MB/core). Doubling `size` does *not*
double memory — entries vary enormously, and a broad-taxon DocSet is far larger than a
typical one — but it is the right order-of-magnitude worry.

From the 2026-10-16 sampler run, a representative node reported
`heap_max_bytes: 32212254720` (30 GB) with `heap_used_bytes: 2493206168` (2.3 GB) at rest.
Confirm current headroom on the nodes you intend to change before touching anything:

```bash
# per instance, on a data node
curl -sk -u USER:PASS \
  'https://HOST:PORT/solr/admin/metrics?group=jvm&prefix=memory.heap' \
  | python3 -m json.tool | grep -E 'used|max'
```

A node whose heap is already above ~60% at rest is not a candidate — raise the heap first,
or skip that node.

---

## 1. Capture a baseline

Use the script from the investigation (`~/Downloads/cache-stats.sh`, also recorded in
§7 of the root-cause doc). Run it **twice, ~2 minutes apart** — the delta in `evictions`
is the signal; a single reading tells you almost nothing.

```bash
for h in arborvitae balsam bio-gp1 bio-gp2 bio-gp3 butternut cottonwood magnolia willow; do
  ssh $h 'bash -s' < cache-stats.sh > before-1.$h.txt
done
sleep 120
for h in …same…; do ssh $h 'bash -s' < cache-stats.sh > before-2.$h.txt; done
```

Record, for `genome_feature` only: total `cumulative_evictions`, the delta between the two
runs (evictions/second), mean `hitratio`, and total `ramBytesUsed`. Those four numbers are
what you will compare against afterwards.

Reference figures from 2026-10-23 to compare against: **9,605 evictions in 118 s
(81/s)** across 184 cores, with 213,055 lookups in the same window.

---

## 2. Decide the new size

`size` counts **entries**, not bytes, and this is the trap: one broad-taxon DocSet over
1.6 M genomes is a *single* entry but an enormous one. A cache sized purely by entry count
can be thrashing valuable entries while appearing far from full.

Two options, and the second is better here:

**(a) Raise `size`.** Simple, but memory scales with whatever the entries happen to be.
512 → 1024 is the conservative step.

**(b) Set `maxRamMB` instead, and leave `size` generous.** Solr 9 supports a RAM-bounded
`CaffeineCache`, which bounds the thing you actually care about. Current config reports
`maxRamMB: -1` (unbounded) on every core, so this is not set today.

```xml
<!-- solrconfig.xml, genome_feature configset -->
<filterCache class="solr.CaffeineCache"
             size="2048"
             initialSize="512"
             maxRamMB="768"
             autowarmCount="0"/>
```

**Keep `autowarmCount="0"`.** Autowarming re-executes cached filters against the new
searcher on every commit. With broad-taxon DocSets in the cache and an hourly ingest, that
would move the 258 s build onto the commit path and stall the searcher swap. If you later
want warm broad taxa, use an explicit `newSearcher` listener with a *named, bounded* set of
queries — not blanket autowarm.

Pick the numbers against measured headroom: 184 cores × 768 MB is 141 GB if every core
fills, which is more than today's 107.8 GB. Size `maxRamMB` so that
`cores_per_node × maxRamMB` stays inside the heap you confirmed in step 0.

---

## 3. Apply to ONE node first

Do not roll the cluster. The point of a single-node change is that the other eight are
the control group.

```bash
# 1. upload the modified configset
solr zk cp solrconfig.xml zk:/configs/genome_feature/solrconfig.xml -z ZKHOST

# 2. reload on ONE node only, one core, to start
curl -sk -u USER:PASS \
  'https://HOST:PORT/solr/admin/cores?action=RELOAD&core=genome_feature_shardNN_replica_tNNN'
```

A core RELOAD discards that core's caches — so the node will be briefly slower while they
refill. That is expected and is itself a data point: time how long it takes `hitratio` to
return to its baseline.

---

## 4. Verify, over at least one full hour

```bash
for h in …; do ssh $h 'bash -s' < cache-stats.sh > after-$(date +%H%M).$h.txt; done
```

Compare the changed node against the unchanged ones:

| if you see | it means |
|---|---|
| evictions/s drops, hitratio rises, heap stable | **working** — proceed to more nodes |
| evictions/s drops, heap climbs toward the ceiling | too generous; lower `maxRamMB` |
| evictions/s unchanged | the working set is far larger than the cache either way; stop and reconsider |
| GC time rises, old-gen collections appear | **revert** — see step 6 |

Watch old-gen GC specifically. The 2026-10-16 A/B measured **zero old-gen collections**
under normal load, so any appearance is a new signal and attributable to this change.

```bash
curl -sk -u USER:PASS 'https://HOST:PORT/solr/admin/metrics?group=jvm&prefix=gc' \
  | python3 -m json.tool | grep -A2 Old
```

Must span **a top-of-hour ingest**, since that is when commits discard caches and the
refill cost is paid.

---

## 5. Roll forward

One node at a time, verifying between each. Nine data nodes, so budget a day or two rather
than an afternoon. There is no deadline pressure: the current state is stable, merely
wasteful.

---

## 6. Rollback

Restore the previous `solrconfig.xml` and RELOAD. No data is at risk at any point — a
filterCache is derived state and is rebuilt from the index on demand. The only cost of a
rollback is a cold cache on the affected cores.

```bash
solr zk cp zk:/configs/genome_feature/solrconfig.xml.bak \
           zk:/configs/genome_feature/solrconfig.xml -z ZKHOST
curl -sk -u USER:PASS 'https://HOST:PORT/solr/admin/cores?action=RELOAD&core=…'
```

**Take the backup before step 3**, not after you need it:

```bash
solr zk cp zk:/configs/genome_feature/solrconfig.xml \
           zk:/configs/genome_feature/solrconfig.xml.bak -z ZKHOST
```

---

## What I could not measure from off-site

Stated plainly so the gaps are not mistaken for recommendations:

- **The actual heap headroom today.** Step 0 exists because I have 2026-10-16 sampler
  figures, not current ones.
- **Whether 512 is actually the configured ceiling** or merely where these cores happen to
  sit. 151 of 184 reading exactly 512 is strong evidence of a ceiling, but reading
  `solrconfig.xml` would confirm it outright — do that before changing it.
- **Whether `maxRamMB` is supported by the deployed cache class.** It requires
  `solr.CaffeineCache` (the Solr 9 default, but the configset may still name
  `solr.FastLRUCache`). Check before assuming option (b) is available.
- **The eviction/hit trade at a larger size.** Nothing here predicts the new hit ratio;
  step 4 measures it. If evictions/s does not drop materially, the working set is simply
  larger than any reasonable cache and the right answer is to stop.
