# Plan: Solr Query Overload Protection

## Context

Coordinated scraping attacks have overwhelmed the BV-BRC API and Solr cluster. Two incidents on 2026-06-02:

1. **Single-IP scrape** (58.250.174.76): 168 genome_sequence downloads over 80 minutes, ~470MB extracted
2. **Distributed scrape** (9 Azure VMs): 245 genome downloads over 2 hours, **10.4 GB genome data**, **136.6 GB total bandwidth**, driving Solr host load averages to 200 (2x core count on balsam) and causing **43 x 502 errors** for legitimate users

### Root Cause: Query Amplification

The primary damage is not from the genome queries themselves (genome is a single-shard collection). It comes from the **media serializers** (FASTA, GenBank) making massive numbers of secondary queries during response streaming.

Each genome FASTA download triggers ~370 `feature_sequence` lookups via the serializer. During the peak (13:30-14:00), this produced **15,000+ feature_sequence queries in 30 minutes** across the two Solr HAProxy proxies — 500/minute — saturating shard hosts like arborvitae (21 JVMs) and balsam (19 JVMs).

The 502 errors were caused by the API layer being unable to service new requests while streaming multiple 50MB genome responses with concurrent secondary queries, not by Solr rejecting queries directly.

### Serializer Code Paths

| Serializer | Direct Solr path | Legacy axios path | Concurrency control |
|---|---|---|---|
| `media/dna+fasta.js` | Yes (SequenceJoinStream, DirectSolrClient) | Fallback + genome metadata | maxSockets: 10 on direct agent; **none** on axios fallback |
| `media/protein+fasta.js` | Yes (same pattern) | Fallback + genome metadata | Same as dna+fasta |
| `media/genbank.js` | **No** | 5 separate axios call sites, all via distributeURL | **None** — unlimited default axios |

GenBank completely bypasses the direct Solr path and its socket limits. All its sequence fetches go through the full API roundtrip (axios → distributeURL → API → HAProxy → Solr coordinator → shards) with no concurrency control.

### Infrastructure

- **API instances**: 3 main (p3-api), 3 web, 3 internal, 3 bulk — on walnut and chestnut
- **Solr coordinators**: walnut, chestnut (via HAProxy, 6 backends each)
- **Solr shard hosts**: arborvitae (21 JVMs), balsam (19), walnut (18), chestnut (15), bio-gp2 (11), bio-gp1 (10), butternut (9), magnolia (7), larch (7), bio-gp3 (6), cottonwood (3)
- **Host CPUs**: ~80 cores per host
- **HAProxy**: Two Solr-facing proxies; showed zero 5xx, max 18 active connections during spike — coordinators were fine; shard hosts were not

---

## Recommended Throttling / Admission Strategy

### Goal

Prevent any single client or traffic burst from saturating individual Solr shard hosts, while allowing full cluster utilization for legitimate concurrent workloads.

### Layer 1: API Admission Control (primary defense)

Limit concurrent heavy requests per API instance. This bounds how many "amplifiers" can run at once.

**Classification** (middleware after Limiter, before Solr dispatch):
- **Heavy**: `rows >= 10000`, `isDownload === true`, or `call_method === 'stream'`
- **Interactive**: everything else (small queries, schema, single-doc gets)

**Separate pools**:
- Heavy: 2-3 concurrent per instance (configurable)
- Interactive: 20 concurrent per instance (configurable)
- Returns 429 with `Retry-After` header when pool is full — no queuing

**Why this works**: It doesn't matter how many source IPs the attacker uses. It limits total concurrent heavy work, and the secondary query volume follows. With 2 heavy downloads × 3 instances × current amplification, shard load drops from 150 to ~30 concurrent queries.

**Files**:
- New: `lib/SolrAdmissionControl.js` — counting semaphore singleton
- New: `middleware/QueryClassifier.js` — sets `req.queryCategory`
- Edit: `middleware/APIMethodHandler.js` — acquire/release around querySOLR/streamQuery
- Edit: `middleware/DistributedQuery.js` — same pattern
- Edit: `routes/dataType.js` — insert QueryClassifier in middleware chain
- Edit: `config.js` — add `queryAdmission` defaults
- Edit: `app.js` — expose stats at `/stats`

### Layer 2: Serializer Concurrency Control (amplification throttle)

Each download that gets through Layer 1 should limit its own shard impact.

**Direct Solr path** (`dna+fasta.js`, `protein+fasta.js`):
- Lower `maxSockets` on the HTTPS agent from 10 to 4-5 (`dna+fasta.js:142-146`)
- Optionally reduce `prefetchBatches` from 2 to 1
- The agent is already a singleton — shared across concurrent downloads on the same instance

**Legacy axios path** (`genbank.js`, `featureSequence.js`, fallback in FASTA serializers):
- Create a shared connection-limited axios instance with `maxSockets` per host
- Replace the 5 bare `axios.post()` / `axios()` calls in `genbank.js` and the call in `featureSequence.js`
- This prevents the legacy path from bypassing the throttle when direct Solr is unavailable

**Combined effect**: `concurrent_downloads × sockets_per_download` gives total shard load. With Layer 1 capping downloads to 2-3 per instance and Layer 2 capping sockets to 4-5, total concurrent shard queries from serializers drops to 24-45 across all 3 main API instances (vs. uncapped ~150+ currently).

**Files**:
- Edit: `media/dna+fasta.js:142-146` — lower maxSockets
- Edit: `media/protein+fasta.js` — same change (uses same pattern)
- Edit: `media/genbank.js` — add shared connection-limited axios instance for all 5 call sites
- Edit: `util/featureSequence.js` — use connection-limited axios instance
- Port `genbank.js` to use DirectSolrClient (see detailed plan below)

### Layer 2b: Port GenBank Serializer to Direct Solr

`media/genbank.js` currently makes all data fetches via axios through the full API roundtrip (`distributeURL` → nginx → API → HAProxy → Solr coordinator → shards). This is the worst amplifier: a genome with N contigs generates N+2 roundtrip HTTP requests (1 genome metadata + 1 contig stream + N per-contig feature queries via `streamFeaturesForContig()`).

**Current call pattern per genome download:**

| Function | Collection | Calls | Route |
|---|---|---|---|
| `fetchGenome()` | `genome` | 1 | Full API roundtrip |
| `streamGenbankMultiRecord()` | `genome_sequence` | 1 (streaming) | Full API roundtrip |
| `streamFeaturesForContig()` | `genome_feature` | **1 per contig** | Full API roundtrip |
| `fetchContigs()` (merged mode) | `genome_sequence` | 1 | Full API roundtrip |
| `fetchFeatures()` (merged mode) | `genome_feature` | 1 | Full API roundtrip |

A genome with 100 contigs → 102 HTTP roundtrips through the full stack.

**`DirectSolrClient` already provides everything needed:**
- `fetchGenomeMetadata(genomeIds)` — genome metadata lookup
- `query(collection, params)` — general Solr query with fq, fl, sort, rows
- `fetchByIds(collection, field, values)` — batch ID-based lookup

**Ported call pattern per genome download:**

| Replacement | Collection | Calls | Route |
|---|---|---|---|
| `directClient.fetchGenomeMetadata([genomeId])` | `genome` | 1 | Direct to shard |
| `directClient.query('genome_sequence', {fq, sort, rows})` | `genome_sequence` | 1 | Direct to shard |
| `directClient.query('genome_feature', {fq, fl, sort, rows})` | `genome_feature` | **1** | Direct to shard |

A genome with 100 contigs → **3 direct Solr queries** regardless of contig count.

**Implementation approach — fetch all features upfront, group by accession:**

1. Add `initializeDirectSolr()` to genbank.js (same singleton pattern as `dna+fasta.js:98-166`)
2. Replace `fetchGenome()` → `directClient.fetchGenomeMetadata([genomeId])`
3. Replace `fetchContigs()` → `directClient.query('genome_sequence', {fq: 'genome_id:X', rows: 10000, sort: 'accession asc'})`
4. Replace `fetchFeatures()` → `directClient.query('genome_feature', {fq: 'genome_id:X', rows: 100000, fl: fields, sort: 'start asc'})`
5. Replace `streamGenbankMultiRecord()`:
   - Fetch ALL features for the genome in one `directClient.query()` call upfront
   - Group features by accession in a `Map`
   - Fetch all contigs in one query
   - Iterate contigs sequentially: write header, look up features from the map, write origin
   - Eliminates `streamFeaturesForContig()` entirely — no more per-contig queries
6. Keep legacy axios as fallback if `initializeDirectSolr()` returns null (same pattern as FASTA serializers)
7. The direct client shares the connection-limited HTTPS agent (maxSockets: 4-5) with the FASTA serializers

**Result**: GenBank downloads go from N+2 API roundtrip calls to 3 direct shard queries, all through the throttled agent. The per-contig amplification is eliminated entirely.

**Files**:
- Edit: `media/genbank.js` — add `initializeDirectSolr()`, replace 5 axios call sites, restructure streaming mode
- Reuse: `lib/distributed/DirectSolrClient.js` — no changes needed, existing `query()` and `fetchGenomeMetadata()` methods suffice
- Reuse: `lib/distributed/SolrClusterClient.js` — singleton instance shared with FASTA serializers

### Layer 3: Solr Self-Protection (safety net)

Optional defense-in-depth for anything the API-side controls don't catch.

**Circuit breakers** (per Solr node, in `solr.in.sh`):
```bash
SOLR_CIRCUITBREAKER_QUERY_LOADAVG=50    # ~0.6x core count on 80-core hosts
SOLR_CIRCUITBREAKER_QUERY_CPU=90
```

**Rate limiter** (per Solr node, via cluster API):
```json
{"set-ratelimiter": {"enabled": true, "allowedRequests": 20, "slotAcquisitionTimeoutInMS": -1}}
```

Both return 429, requiring all callers to handle it (see 429 requirements below).

---

## 429 System-Wide Requirements

All three layers return 429 when they activate. Every consumer must handle it.

| Component | Current handling | Required |
|---|---|---|
| p3-api APIMethodHandler | Treats non-success as generic error | Propagate 429 with Retry-After to client |
| p3-api ShardCursorStream | Retries same replica 3x | On 429: try different replica |
| p3-api serializers (axios) | UnhandledRejection on 502 | Catch, retry with backoff, or propagate |
| CLI tools | No 429 handling | Retry with exponential backoff |
| Website (BV-BRC web app) | No 429 handling | Show "server busy" message, auto-retry |
| HAProxy (Solr-facing) | Passes through | Optionally: `retry-on 429` with `redispatch` |

---

## Implementation Sequence

### Phase 1: Immediate, zero client impact

- Lower `maxSockets` on serializer agents (dna+fasta.js, protein+fasta.js)
- Add connection-limited axios instance for genbank.js and featureSequence.js
- Downloads run slower during spikes but nothing breaks, no 429s issued

### Phase 2: API admission control

- Build QueryClassifier middleware and SolrAdmissionControl
- Wire into APIMethodHandler and DistributedQuery
- Returns 429 — requires concurrent client updates
- Update CLI tools and website to handle 429

### Phase 3: Solr safety net

- Enable circuit breakers on all Solr nodes
- Enable rate limiter via cluster API
- Ensure API handles 429 from Solr (propagate or try alternate replica)

---

## Observed Attack Patterns

### Attack 1: Single-IP scrape (58.250.174.76)

- **Time**: 09:37-10:57 (80 minutes)
- **Target**: `POST /genome_sequence` (~2.8MB per response)
- **Pattern**: Sequential requests, 1-2/min, `libwww-perl/6.61`
- **Impact**: ~470MB extracted, drove load averages over 500
- **Stopped by**: Auth expiry (started getting 403)

### Attack 2: Coordinated distributed scrape (9 Azure IPs)

- **Time**: 12:01-14:15 (2h 13min), same day
- **Source IPs**: 9 Azure VMs (20.x, 52.x, 172.x, 74.x, 68.x, 13.x, 48.x ranges)
- **User agent**: `libwww-perl/6.68` (all identical)
- **Pattern**: Each IP does ~800 taxonomy lookups then ~25-33 genome downloads (~50MB each, 6-15s response time)
- **Concurrency**: Up to 5 concurrent genome queries per API instance, 13/minute across all IPs
- **Query amplification**: 245 genome downloads → ~90,000 feature_sequence queries (370x amplification via FASTA serializers)
- **Impact**: 10.4 GB genome data, 136.6 GB total bandwidth, 43 x 502 errors, load 200 on balsam, load 80 on arborvitae
- **Load distribution**: arborvitae (21 JVMs, 80 cores) and balsam (19 JVMs) hit hardest due to hosting the most shard replicas
- **Self-limiting**: Load returned to baseline after scrape completed
- **Key insight**: Per-IP rate limiting would NOT stop this — each IP individually looks moderate. Global concurrency control is required.

### Anatomy of the 502 errors

- 41 of 43 502s were taxonomy queries, not genome downloads
- Taxonomy has single shard with leader on arborvitae — same host saturated by feature_sequence shard queries
- Both Solr-facing HAProxy proxies showed zero 5xx, max 18 connections — Solr coordinators were fine
- 502s originated between nginx and the API processes: API was overwhelmed streaming 50MB responses
- API logs show `UnhandledRejection: AxiosError: Request failed with status code 502` — secondary axios calls from serializers failing when coordinators slowed under feature_sequence load

---

## Open Questions

- **How many API instances to run?** Fewer instances makes per-process admission control simpler to reason about. Node.js handles I/O-bound work well in a single process. 2 instances provides redundancy without coordination complexity.
- **HAProxy config access?** Can we modify the Solr backend config to add `retry-on 429`?
- **Client update scope?** Which CLI tools and website components need 429 support?
- **Rollout order?** Phase 1 (serializer throttling) can deploy immediately with no client changes. Phase 2 (admission control with 429) needs coordinated client updates.
