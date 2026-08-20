# Chestnut Coordinator Crash — 2026-07-09 ~16:23

**Log:** `solr.c06.chestnut.log`
**Node type:** SolrCloud coordinator (chestnut.cels.anl.gov)
**Span:** 2026-07-07 00:22 → 2026-07-09 16:26
**Failure mode:** JVM freeze → ZooKeeper session expiry (distinct from the June 25 data-node OOM)

---

## What Happened

The chestnut JVM froze for ~3 minutes starting around 16:23, almost certainly a Full GC
stop-the-world pause. Because the JVM was stopped, it could no longer send ZooKeeper
heartbeats. After 180 seconds of silence, ZooKeeper expired the session and chestnut
disconnected from the cluster.

### Timeline

| Time (2026-07-09) | Event |
|---|---|
| 04:56 – 06:06 | Cluster node churn: live nodes slide from 131 → 125 over 70 min (maintenance or node instability) |
| 14:19 – 14:20 | All nodes return; cluster stabilizes at 131 live nodes |
| 15:47 | **`taxon_lineage_ids:2697049`** join on `genome_v02` with `facet.pivot=state_province,county` — **108,875ms (1.8 min), 9.4M hits**. This is SARS-CoV-2 root, a known never-completes-within-timeout taxon. |
| 16:16:53 | `taxon_lineage_ids:470` (Acinetobacter) join on `genome_feature` — 14,756ms, **115M hits** |
| 16:21:41 | Last queries logged normally (QTimes normal, no errors) |
| ~16:23:09 | JVM freezes — last ZK heartbeat inferred (16:26:10 − 180s) |
| 16:26:10 | ZooKeeper WARN: `Client session timed out, have not heard from server in 180561ms` |
| 16:26:35 | `SessionTimeoutException` → log ends |

One in-flight query was abandoned at the freeze: `pathway` request 292863 (text search for "SAMN13340376"), no completion logged.

---

## Why the Coordinator Froze (not just data nodes)

The June 25 crash was an OOM on data nodes from DocSet accumulation in heap. This crash
is on the **coordinator**: same root cause (crossCollection joins materializing huge DocSets),
different victim.

The coordinator aggregates per-shard join results. For `taxon_lineage_ids:2697049` (SARS-CoV-2,
~16M genomes), each of the data-node shards returns matching genome_ids; the coordinator
collects and re-emits them. For `taxon_lineage_ids:11118` (Coronaviridae) at 582M
genome_feature hits, even the facet response from each shard is massive. This creates
heap pressure on chestnut even though it holds no shard data.

A 1.8-minute wall-clock join that completed at 15:47 would have left large objects alive
in the coordinator heap during GC survivor promotion. If those objects were not reclaimed
by the time the next set of heavy queries arrived (16:16), a Full GC cascade is plausible.

---

## Join Load (2.5-day window)

**4,898 total join queries — 355 hours CPU time on coordinator alone.**

| Taxon | Queries | CPU total | p99 | Max | Description |
|---|---|---|---|---|---|
| **10239** | 665 | **179m** | 10m | 10m (timeout) | Viruses root — all time out at 600s |
| **2** | 2,135 | **80m** | 23.8s | 9.7m | All Bacteria — most complete but some time out |
| **2697049** | 9 | **25m** | 10m | 10m (timeout) | SARS-CoV-2 root — never completes |
| **11118** | 4 | **14m** | 6.2m | 6.2m | Coronaviridae — never completes |
| **197911** | 12 | **12.7m** | 4.2m | 4.2m | Orthomyxoviridae (influenza) — new entrant, slow |
| 286 | 300 | 4.8m | 8.9s | 12.5s | Pseudomonas — completes but slow |
| 562 | 351 | 3.9m | 4.1s | 8.9s | E. coli — generally OK |

**The four known blocking-candidate taxons (10239, 2697049, 11118, and to a lesser degree 11320)
are all present, all at max timeout. Taxon 197911 (influenza) is a new concern at p99=4.2 min.**

Top worst single queries (by QTime):

| QTime | Collection | Taxon | Status |
|---|---|---|---|
| 600,024ms | genome_sequence | 10239 | timeout |
| 600,022ms | genome_feature | 10239 | timeout |
| 600,011ms | genome_sequence | 2697049 | timeout |
| 586,367ms | genome_feature | 10239 | 395M hits — returned |
| 582,322ms | genome_sequence | 2 | 260M hits — returned |
| 108,875ms | genome_v02 | 2697049 | 9.4M hits + pivot facet — **proximate trigger** |

---

## Cluster Instability (Morning of July 9)

From 04:56 to 06:06, live node count slid from 131 to 125 with frequent up/down
transitions:

```
04:56  131 → 130
05:13  130 → 129
05:15  129 → 128
05:17  128 → 127 / 127 → 128 (rapid bounce)
05:20  128 → 127
...
05:44  126 → 125
06:06  125 → 126  (then stable until 14:19)
14:19-14:20  125 → 131 (rapid recovery, likely node restarts)
```

Six nodes dropped off during the morning period. The recovery at 14:19 shows rapid
sequential reconnection (all back within 1 minute), consistent with a planned restart
rather than cascading failure. The cluster was fully stable from 14:20 until the crash.

---

## Application Errors (across 2.5-day window)

| Error | Count | Root cause |
|---|---|---|
| `Total timeout 600000 ms elapsed` | Many | Join queries on blocking taxons |
| `SyntaxError: ...!host_health:)` | ~20 | Malformed query: empty `!host_health:` filter |
| `undefined field host_common_name` | 2 | Schema field absent from genome_sequence |
| `no field name specified via 'df' param` | ~30 | Malformed query routed through magnolia; likely a client bug |

The `!host_health:` syntax error (`Cannot parse '...(genome_length:[5000 TO 20000] AND !host_health:)':
Encountered ")" ") ""`) originates from a specific query pattern — an empty field exclusion
clause. This is a client-side bug sending malformed Lucene syntax.

---

## ZooKeeper Note

ZooKeeper is healthy. The 5-node ensemble (bio-gp1, bio-gp2, hemlock, balsam, butternut)
is fully operational with butternut currently serving as the **ZK leader**. The session
expiry was entirely caused by the chestnut JVM being frozen and unable to send heartbeats —
ZK itself was not a contributing factor.

---

## Comparison: June 25 vs July 9

| | June 25 (balsam) | July 9 (chestnut) |
|---|---|---|
| Node type | Data node | Coordinator |
| Failure mode | OOM / JVM killed | GC freeze → ZK session expiry |
| Visible in log | No ERROR/WARN — silent death | ZK WARN at end |
| Root cause | DocSet accumulation in data heap | Join aggregation in coordinator heap |
| Trigger queries | taxon:2, taxon:11118 | taxon:2697049, taxon:10239 |
| GC log available | Yes (solr_gc.log.2) | No |

---

## Prevention

These items are grouped by owner and effort. Items 1–3 directly address the crash root
cause; the rest reduce background damage.

### Immediate / p3api (high urgency)

**1. Block the always-timeout taxons at the API layer.**
These taxons have never completed a join within the 600-second timeout over hundreds of
attempts. Every query is pure CPU/heap burn with no user-visible result. Block at p3api
before the request reaches Solr:

| Taxon ID | Name | Evidence |
|---|---|---|
| 10239 | Viruses (root) | 665 queries, 179m CPU, p99=10m, all timeout |
| 2697049 | SARS-CoV-2 (root) | 9 queries, 25m CPU, all timeout — proximate trigger of this crash |
| 11118 | Coronaviridae | 4 queries, 14m CPU, all timeout |
| 197911 | Orthomyxoviridae (influenza) | 12 queries, 12.7m CPU, p99=4.2m — new this window |

Return HTTP 400 or a user-facing message ("this taxon is too broad for real-time search;
use the download service instead"). Do not forward to Solr.

**2. Implement `canCancel=true` + browser-disconnect handler in p3api.**
Even for taxons not in the block list, an abandoned browser request currently runs to
completion (or OOM). See `solr-query-cancellation.md` for the implementation pattern using
Solr 9.x Task Management API. This is belt-and-suspenders behind the block list.

### Immediate / client bug fixes

**3. Fix the `!host_health:` malformed query.**
A client is generating `fq=(genome_length:[5000 TO 20000] AND !host_health:)` — the empty
field exclusion `!host_health:` is invalid Lucene syntax and causes a 500 on every call
(~20 errors in this window). Find the code constructing the `host_health` filter and
guard against emitting it when the value is empty.

**4. Fix the `host_common_name` undefined-field queries.**
`genome_sequence` does not have a `host_common_name` field. The queries fail with a 400
client error. Either add the field to the schema or remove it from the query.

### Solr-side / medium effort

**5. Enable GC logging on chestnut.**
The June 25 crash had `solr_gc.log.2` available; this event does not. Without a GC log we
cannot confirm the Full GC hypothesis or measure pause duration. Add
`-Xlog:gc*:file=/var/log/solr/solr_gc.log:time,uptime:filecount=5,filesize=20m` to
chestnut's JVM flags.

**6. Increase coordinator heap or tune G1GC region size.**
The coordinator holds no shard data but accumulates large join result sets. If chestnut's
heap is smaller than the data nodes', it will saturate sooner under join load. Profile
coordinator heap usage during a busy period. Consider `-XX:G1HeapRegionSize=16m` if
humongous allocations are occurring (join DocSets can be large contiguous byte arrays).

**7. Add a Solr CircuitBreakerPlugin on coordinators.**
Configure heap-based circuit breaking (`solr.admin.api.CircuitBreakerPlugin`,
`memUsageThreshold=85`) so that new join requests are rejected with HTTP 503 when the
coordinator heap is already under pressure, rather than piling on and triggering GC
collapse. This gives p3api a signal to back off rather than losing the whole coordinator.

### Monitoring

**8. Alert on coordinator ZK session loss.**
A `SessionTimeoutException` in a Solr coordinator log means the node is effectively dead
to the cluster. Add a log-based alert (e.g. Splunk / Grafana Loki) on
`SessionTimeoutException` so on-call is paged immediately rather than discovering it
from user reports.

**9. Alert on join query QTime > 120s.**
Any join query exceeding 2 minutes is either on a blocking taxon (should have been blocked)
or is unexpectedly slow. A real-time alert gives enough lead time to cancel or rate-limit
before GC collapse.
