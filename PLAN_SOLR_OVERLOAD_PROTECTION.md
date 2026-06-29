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

- **API instances**: 3 main (p3-api), 3 web, 3 internal, 3 bulk — on elm
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

### Layer 3: Per-Host Admission Control (distributed query path)

The API admission control (Layer 1) limits total concurrent heavy requests, and the serializer throttle (Layer 2) limits sockets per request, but neither knows which **physical Solr host** the queries are hitting. Arborvitae runs 21 JVMs — queries to any of those JVMs load the same host. The Solr rate limiter (Layer 4) is per-JVM, so 21 JVMs each allowing N queries means the host still gets 21×N.

This layer tracks active queries per physical host (`hostname`, not `hostname:port`) in the distributed query path, where the target host is known.

**Where it fits:**

The distributed query system queries shard replicas directly via `ShardCursorStream._request()`, where `parsedUrl.hostname` is available. This is the point to track and limit per-host concurrency.

**Implementation:**

A `HostAdmissionControl` module (or extend `SolrAdmissionControl`) that tracks:
- Active query count per hostname (not per hostname:port — all JVMs on a host share the limit)
- Configurable max concurrent queries per host (e.g., 15-20)

**Integration points:**

1. **`ShardCursorStream._request()`** (`lib/distributed/ShardCursorStream.js:183`): Before making the HTTP request, call `hostAdmission.acquire(hostname)`. On response completion or error, call `hostAdmission.release(hostname)`. If acquire fails, return a retriable error so `_requestWithRetry()` can back off.

2. **`SolrClusterClient.getShardsForCollection()`** (`lib/distributed/SolrClusterClient.js:222`): Make replica selection load-aware. Instead of random selection:
   ```
   // Current: random
   const selectedReplica = activeReplicas[Math.floor(Math.random() * activeReplicas.length)]

   // New: prefer least-loaded host
   const selectedReplica = activeReplicas.reduce((best, replica) => {
     const bestHost = extractHostname(best.base_url)
     const thisHost = extractHostname(replica.base_url)
     return hostAdmission.getLoad(thisHost) < hostAdmission.getLoad(bestHost) ? replica : best
   })
   ```
   This steers queries toward replicas on less-loaded hosts rather than randomly hitting saturated ones.

3. **`DirectSolrClient._request()`** (`lib/distributed/DirectSolrClient.js:47`): Same acquire/release pattern. This covers the serializer sequence lookups that go through direct Solr.

4. **Pass instance through**: `DistributedQueryManager` → coordinators/streams → `ShardCursorStream`. Also pass to `DirectSolrClient` instances created by the serializers.

**What this covers vs. doesn't:**

| Path | Per-host control? | Why |
|---|---|---|
| Distributed queries | Yes — `ShardCursorStream` knows the target host | Queries go direct to shard replicas |
| Direct Solr (serializer sequence lookups) | Yes — `DirectSolrClient` knows the target host | Queries go direct to shard replicas |
| Proxy queries (via coordinators) | **No** — coordinator fans out internally | API doesn't know which shard host the coordinator selects |

For proxy queries, Layer 4 (Solr circuit breakers) serves as the backstop — the shard hosts themselves reject queries when overloaded.

**Configuration** (in `p3api.conf`):
```json
{
  "queryAdmission": {
    "maxPerHost": 15
  }
}
```

**Stats**: Expose per-host active counts at `/stats` alongside the global admission stats.

**Files**:
- New or extend: `lib/SolrAdmissionControl.js` — add per-host tracking (acquire/release/getLoad by hostname)
- Edit: `lib/distributed/ShardCursorStream.js:183` — acquire/release around `_request()`
- Edit: `lib/distributed/DirectSolrClient.js:47` — acquire/release around `_request()`
- Edit: `lib/distributed/SolrClusterClient.js:222` — load-aware replica selection
- Edit: `lib/distributed/DistributedQueryManager.js` — pass admission control instance through

### Layer 4: Solr Self-Protection (safety net)

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

All four layers can return 429 when they activate. Every consumer must handle it.

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
- Port genbank.js to use DirectSolrClient (eliminates per-contig amplification)
- Downloads run slower during spikes but nothing breaks, no 429s issued

### Phase 2: API admission control + per-host admission

- Build QueryClassifier middleware and SolrAdmissionControl (Layer 1)
- Wire into APIMethodHandler and DistributedQuery
- Add per-host tracking to ShardCursorStream and DirectSolrClient (Layer 3)
- Add load-aware replica selection to SolrClusterClient
- Returns 429 — requires concurrent client updates
- Update CLI tools and website to handle 429

### Phase 3: Solr safety net

- Enable circuit breakers on all Solr nodes (Layer 4)
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

## Detailed Code Changes

### Phase 1: Serializer Throttling (no 429, no client changes)

#### `media/dna+fasta.js`
- **Line 144**: Change `maxSockets: 10` to `maxSockets: 5` on the HTTPS agent
- **Line 243** (optional): Change `prefetchBatches` default from 2 to 1

#### `media/protein+fasta.js`
- Same `maxSockets` and `prefetchBatches` changes as dna+fasta.js (uses identical pattern)

#### `media/genbank.js` — Port to DirectSolrClient
- Add `initializeDirectSolr()` function (copy pattern from `dna+fasta.js:98-166`)
- Replace `fetchGenome()` (lines 681-705): Use `directClient.fetchGenomeMetadata([genomeId])`, fall back to axios if direct client unavailable
- Replace `fetchContigs()` (lines 710-733): Use `directClient.query('genome_sequence', {fq: 'genome_id:X', rows: 10000, sort: 'accession asc'})`, fall back to axios
- Replace `fetchFeatures()` (lines 738-773): Use `directClient.query('genome_feature', {fq: 'genome_id:X', rows: 100000, fl: fields, sort: 'start asc'})`, fall back to axios
- Rewrite `streamGenbankMultiRecord()` (lines 506-676): Remove streaming contig parser and per-contig feature fetching. Instead:
  1. Fetch all contigs via `directClient.query()` (one call)
  2. Fetch all features via `directClient.query()` (one call)
  3. Group features by accession in a `Map`
  4. Iterate contigs, writing header + features from map + origin for each
- Remove `streamFeaturesForContig()` (lines 368-490) — no longer needed
- For legacy fallback: wrap remaining axios calls with a shared connection-limited axios instance (see featureSequence.js below)

#### `util/featureSequence.js`
- **Line 67**: Replace bare `axios.post()` with a shared connection-limited instance:
  ```javascript
  const http = require('http')
  const limitedAgent = new http.Agent({ maxSockets: 5, keepAlive: true })
  // ... use limitedAgent in axios config
  ```
- This also fixes the `UnhandledRejection` issue — the axios error at line 67 propagates to the caller but isn't caught in the media serializer fallback paths

### Phase 2: Admission Control (returns 429, requires client updates)

#### New: `lib/SolrAdmissionControl.js`
- Singleton class with three concerns:
  - **Global heavy/interactive pools**: `acquireGlobal(category)`, `releaseGlobal(category)` — counting semaphore, returns true/false
  - **Per-host tracking**: `acquireHost(hostname)`, `releaseHost(hostname)`, `getHostLoad(hostname)` — `Map<hostname, count>`, keyed by hostname not hostname:port
  - **Stats**: `stats()` returning `{ heavy: {active, max}, interactive: {active, max}, hosts: {hostname: count, ...} }`
- Configuration from `config.get('queryAdmission')`:
  ```javascript
  {
    heavyMax: 3,           // concurrent heavy requests per API instance
    interactiveMax: 20,    // concurrent interactive requests per API instance
    heavyThreshold: 10000, // rows threshold for heavy classification
    maxPerHost: 15         // concurrent queries per physical Solr host
  }
  ```
- Export singleton: `module.exports = new SolrAdmissionControl(config)`

#### New: `middleware/QueryClassifier.js`
- Express middleware, runs after Limiter
- Sets `req.queryCategory = 'heavy' | 'interactive'` based on:
  ```javascript
  if (req.call_method === 'stream') return 'heavy'
  if (req.isDownload) return 'heavy'
  if (req.call_method === 'get' || req.call_method === 'schema') return 'interactive'
  const rowsMatch = (req.call_params[0] || '').match(/&rows=(\d+)/)
  const rows = rowsMatch ? parseInt(rowsMatch[1], 10) : 25
  if (rows >= config.heavyThreshold) return 'heavy'
  return 'interactive'
  ```
- Does not block — classification only

#### `middleware/APIMethodHandler.js`
- Import `SolrAdmissionControl`
- In `querySOLR()` (line 40): Before `solrClient.query()`, call `admissionControl.acquireGlobal(req.queryCategory)`. If returns false, respond with `res.status(429).set('Retry-After', '5').json({status: 429, message: 'Too many concurrent requests'})` and return
- On query completion (resolve or reject in the `.then()` at line 62): call `admissionControl.releaseGlobal(req.queryCategory)`
- In `streamQuery()` (line 10): Same pattern around `solrClient.stream()` at line 30
- `getSOLR()` and `getSchema()` bypass admission control — lightweight single-doc lookups

#### `middleware/DistributedQuery.js`
- Import `SolrAdmissionControl`
- Before dispatching distributed query (~line 340): `acquireGlobal(req.queryCategory)`. If false, return 429
- On completion: `releaseGlobal(req.queryCategory)`

#### `routes/dataType.js`
- Import `QueryClassifier`
- Insert in middleware chain after Limiter (currently position 4, line ~224), before JoinFieldInjector:
  ```javascript
  // Current:  ...Limiter, JoinFieldInjector, DistributedQuery...
  // New:      ...Limiter, QueryClassifier, JoinFieldInjector, DistributedQuery...
  ```

#### `lib/distributed/ShardCursorStream.js`
- Accept `admissionControl` in constructor options
- In `_request()` (line 183):
  - Extract hostname: `const hostname = new URL(url).hostname`
  - Before HTTP request: `if (!this.admissionControl.acquireHost(hostname))` — throw retriable error
  - On response end/error: `this.admissionControl.releaseHost(hostname)`
  - Ensure release in all code paths (success, error, timeout, destroy)

#### `lib/distributed/DirectSolrClient.js`
- Accept `admissionControl` in constructor options
- In `_request()` (line 47):
  - Same acquire/release pattern as ShardCursorStream
  - Extract hostname from URL, acquire before request, release on completion/error

#### `lib/distributed/SolrClusterClient.js`
- Accept `admissionControl` in constructor options
- In `getShardsForCollection()` (line 222): Replace random replica selection with load-aware:
  ```javascript
  // Sort by host load ascending, pick first (least loaded)
  const selectedReplica = activeReplicas
    .map(r => ({ replica: r, load: this.admissionControl?.getHostLoad(extractHostname(r.base_url)) || 0 }))
    .sort((a, b) => a.load - b.load)[0].replica
  ```
- Falls back to random if `admissionControl` is not set (backward compatible)

#### `lib/distributed/DistributedQueryManager.js`
- Import and instantiate `SolrAdmissionControl` (or accept via options)
- Pass `admissionControl` to:
  - `SolrClusterClient` constructor
  - `ParallelQueryCoordinator` and `MergeSortStream` constructors (which pass to `ShardCursorStream`)
  - `DirectSolrClient` constructor

#### `lib/distributed/ParallelQueryCoordinator.js`
- Accept `admissionControl` in options, pass through to `ShardCursorStream` constructor (line 122-130)

#### `lib/distributed/MergeSortStream.js`
- Accept `admissionControl` in options, pass through to `ShardCursorStream` constructor (line 160-168)

#### `config.js`
- Add `queryAdmission` to nconf defaults:
  ```javascript
  queryAdmission: {
    heavyMax: 3,
    interactiveMax: 20,
    heavyThreshold: 10000,
    maxPerHost: 15
  }
  ```

#### `app.js`
- Import `SolrAdmissionControl`
- Update `/stats` endpoint (lines 151-158) to include admission stats:
  ```javascript
  app.use('/stats', function (req, res, next) {
    const admissionStats = admissionControl.stats()
    res.write(JSON.stringify({ ...stats, solrAdmission: admissionStats }))
    res.end()
  })
  ```

### Phase 2 (client-side): 429 Handling

#### `middleware/APIMethodHandler.js` (additional change)
- In `querySOLR()`: When Solr response has `responseHeader.status !== 0`, check if it's a 429. If so, propagate as 429 to client instead of generic error

#### `lib/distributed/ShardCursorStream.js` (additional change)
- In `_requestWithRetry()` (line 160): On 429 from Solr, treat as retriable but try a **different replica** rather than the same one. This requires access to alternate replica URLs from `SolrClusterClient`

#### CLI tools (external repos)
- Add 429 detection and exponential backoff retry to HTTP client code
- Respect `Retry-After` header

#### Website / BV-BRC web app (external repos)
- Add 429 detection to API client
- Show user-facing "server busy, retrying..." message
- Auto-retry with backoff

### Phase 3: Solr Configuration (no code changes)

#### Solr nodes — `solr.in.sh` on each host
```bash
SOLR_CIRCUITBREAKER_QUERY_LOADAVG=50
SOLR_CIRCUITBREAKER_QUERY_CPU=90
```

#### Solr cluster — via admin API
```bash
curl -X POST 'https://solr-host/solr/admin/collections?action=SET-RATELIMITER' \
  -d '{"enabled": true, "allowedRequests": 20, "slotAcquisitionTimeoutInMS": -1}'
```

#### HAProxy (Solr-facing) — optional
```
backend solr_servers
    option redispatch
    retries 2
    retry-on 429
```

---

## Replica Load Balancing

### Problem

The `shards.preference` configuration controls which replicas receive query traffic. The original configuration (`replica.type:NRT,replica.type:PULL,replica.type:TLOG`) directed 99% of traffic to NRT leader replicas, leaving TLOG followers idle. This concentrated all query load on a subset of hosts.

### Solution

Changed to `replica.base:random` which distributes traffic randomly across all active replicas regardless of type. Verified with the `check-replica-traffic.js` monitoring script — per-replica traffic is now evenly distributed (~0.7-1.2 req/s per replica across all hosts).

### Consistency During Indexing

With `replica.base:random`, queries may hit followers that haven't finished replicating the latest data from the leader. During the hourly indexing window (a few minutes), different replicas may return different results for recently-indexed documents.

**Future enhancement — indexing-aware preference switching:**

During indexing, switch to `replica.leader:true` to ensure consistent results. After replication catches up, switch back to `replica.base:random` for even load distribution.

Implementation options:
1. **Redis signal**: Indexer sets a per-collection key (`indexing:genome_feature`) with TTL when indexing starts. `ShardsPreference` middleware checks the key — if set, uses `replica.leader:true`; otherwise uses `replica.base:random`. API already has Redis for apicache.
2. **Time-based heuristic**: If indexing always runs at the top of the hour, automatically use leader preference for the first N minutes. Simple but fragile.
3. **API endpoint**: Indexer calls a control endpoint on the API to toggle the preference. Requires the indexer to know about the API.

Option 1 (Redis signal) is preferred — minimal coordination, per-collection granularity, and TTL provides automatic fallback if the indexer fails to clear the flag.

### Collections to configure

All collections with multiple replica types should use `replica.base:random`:

```json
{
  "shards": {
    "genome_feature": { "preference": "replica.base:random" },
    "feature_sequence": { "preference": "replica.base:random" },
    "genome_sequence": { "preference": "replica.base:random" },
    "pathway": { "preference": "replica.base:random" },
    "subsystem": { "preference": "replica.base:random" },
    "sp_gene": { "preference": "replica.base:random" },
    "genome_amr": { "preference": "replica.base:random" }
  }
}
```

### Monitoring

Use `scripts/check-replica-traffic.js` to verify distribution:

```bash
# Snapshot of cumulative traffic
node scripts/check-replica-traffic.js -c genome_feature

# Monitor traffic delta over 2 minutes
node scripts/check-replica-traffic.js -c genome_feature -d 120

# Check a specific shard
node scripts/check-replica-traffic.js -c feature_sequence -s shard11
```

The script reads `QUERY./select[shard].requests` (coordinator fan-out sub-queries) from each replica's MBeans endpoint and reports per-shard distribution and per-host aggregates. Flags shards where one replica handles >1.5x the average as imbalanced.

---

## Eliminating Cross-Collection Joins (OOM Crash Prevention)

### Problem

On 2026-06-25, three Solr data nodes crashed simultaneously with JVM heap OOM. Root cause: cross-collection join queries on broad taxon IDs (`taxon_lineage_ids:2` = all Bacteria) generating 57-93M match DocSets per shard, with multiple concurrent sessions multiplying heap pressure. Queries held DocSets alive for up to 330 seconds. See `crash-analysis-2026-06-25.md` for full analysis.

The cross-collection join (`{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}...`) is generated entirely by the API — it is not part of incoming client queries. Every join uses `fromIndex=genome` — the genome collection is always the source.

### Join volume by target collection (from coordinator log analysis, 24,599 joins)

| Target collection | Joins | Notes |
|---|---|---|
| genome_amr | 12,008 | Dominated by taxon:562 (E. coli) — 8,956 of 12,008 |
| genome_v02 (genome) | 8,936 | Self-join; includes explicit genome_id list pattern (safe) |
| genome_feature | 2,445 | The collection that crashed, but not the highest volume |
| genome_sequence | 668 | |
| sp_gene, protein_feature, pathway, ppi, subsystem, strain, surveillance | ~540 combined | |

### Two join patterns — only one is dangerous

1. **Taxon filter** — `taxon_lineage_ids:N` — materializes all genomes in a taxon into the DocSet. Breadth is unbounded (taxon:2 = all Bacteria).
2. **Explicit genome_id list** — `genome_id:(id1 OR id2 OR ...)` — DocSet size equals list length. Bounded, safe.

Extra filters beyond the join and `public:true` are minimal. Only one additional `fq` appears: `feature_type:(CDS OR mat_peptide)` on 1,001 genome_feature queries. No other narrowing happens on the target side.

### genome_v02 self-joins can be eliminated trivially

When genome joins to itself (8,936 queries), taxon joins are redundant — `genome_v02` already has `taxon_lineage_ids`. These can be rewritten to `fq=taxon_lineage_ids:N` directly on genome_v02, eliminating the join with no cache needed.

### Where the join is generated

Only two code locations:

1. **`solrjs.fixed/rql.js:75-91`** — RQL parser `normalized.genome` handler. Constructs the join clause from arbitrary genome collection filters (taxon, genome_status, host_name, etc. — not just taxonomy).
2. **`routes/dataRouter.js:59`** — Hardcoded summary endpoint for taxon category feature counts.

No joins are generated for incoming Solr-format queries. The `SolrQuerySanitizer` does not currently block `{!join}` in client-submitted Solr queries (should be added as defense-in-depth).

### Solution: Local join resolution via SQLite cache

Instead of generating a Solr cross-collection join, resolve the join locally in the API process using a cached `taxon_id → genome_id` mapping, then rewrite the query as a Solr `{!terms}` filter.

**Data flow:**

1. On API startup and after each hourly indexing cycle, query Solr for all genomes: `fl=genome_id,taxon_lineage_ids&rows=*`
2. Build SQLite table:
   ```sql
   CREATE TABLE genome_taxon (taxon_id INTEGER, genome_id TEXT);
   CREATE INDEX idx_taxon ON genome_taxon(taxon_id);
   ```
   Each genome contributes ~5-10 rows (one per lineage ID). ~1M genomes × ~7 avg lineage depth = ~7M rows, ~50MB on disk.
3. When `rql.js` encounters a `genome()` clause with taxon filter:
   - Query SQLite: `SELECT genome_id FROM genome_taxon WHERE taxon_id = ?`
   - If count ≤ 10,000 genome_ids: emit `&fq={!terms f=genome_id}id1,id2,...,idN` instead of the join
   - If count > 10,000: reject with 400 ("taxonomy filter too broad — please select a more specific taxon")
4. Same logic for `dataRouter.js:59`

**Why `{!terms}` instead of OR clauses:** Solr's terms query parser builds an efficient hash set internally. 10,000 IDs × 15 bytes = 150KB query string, fast to parse, low memory. OR clauses build a boolean query tree that's expensive to parse and consumes heap.

**Why 10,000 as the threshold:** A terms query with 10,000 IDs is practical for Solr. Above that, the query string itself becomes large and parsing adds latency. More importantly, taxa with >10,000 genomes (Bacteria: ~500K, Proteobacteria: ~200K) are exactly the queries that crash Solr — blocking them is the right behavior.

**Why SQLite (`better-sqlite3`):**
- Synchronous API — no async complexity in the RQL parser
- Memory-mapped I/O — hot data stays in OS page cache, no GC pressure from large JS objects
- Sub-millisecond lookups with index on taxon_id
- Rebuild is a single transaction (truncate + bulk insert + commit)
- ~50MB on disk vs ~200MB for equivalent JS Map/Set
- Zero external dependencies (process-local, no Redis roundtrip)

### Additional mitigations

**`timeAllowed`**: Inject `&timeAllowed=60000` (60 seconds) into all queries that contain cross-collection joins, regardless of target collection. The join is dangerous across all collections (genome_amr has the highest join volume at 12,008). Inject in `Limiter.js` which already runs for every query — detect `crossCollection` in `req.call_params[0]` and append `&timeAllowed=60000`. This caps how long any query can hold a DocSet in heap. Even if a broad query somehow reaches Solr, it can't hold a DocSet alive for 330 seconds.

**Block `{!join}` in client Solr queries**: Add `join` to the blocked parameter list in `SolrQuerySanitizer.js` to prevent clients from submitting their own cross-collection joins directly.

**Concurrent join query limit**: If any join queries remain (e.g., for non-taxon genome filters that can't be resolved locally), the admission control (Layer 1) should limit concurrent join queries to 1-2 per API instance.

### Code changes

**New: `lib/GenomeTaxonCache.js`**
- SQLite-backed cache using `better-sqlite3`
- `rebuild()` — fetches all genomes from Solr, rebuilds the taxon_id → genome_id table
- `getGenomeIds(taxonId)` — returns array of genome_ids for a taxon
- `getGenomeCount(taxonId)` — returns count without fetching all IDs (for threshold check)
- Singleton, initialized on startup, rebuilt after each indexing cycle

**Edit: `solrjs.fixed/rql.js:75-91`**
- Replace the `{!join}` generation with local resolution:
  ```javascript
  if (normalized.genome && normalized.genome.length > 0) {
    // Extract taxon filter from genome args
    // Look up genome_ids from GenomeTaxonCache
    // If count <= threshold: emit {!terms f=genome_id}id1,id2,...
    // If count > threshold: throw error (too broad)
  }
  ```

**Edit: `routes/dataRouter.js:59`**
- Same rewrite — resolve taxon to genome_ids locally, use `{!terms}` filter

**Edit: `middleware/SolrQuerySanitizer.js`**
- Add `join` to blocked Solr parameters/syntax for client-submitted queries

**Edit: `middleware/Limiter.js`**
- Add `&timeAllowed=60000` to genome_feature queries (or all queries)

**New dependency: `better-sqlite3`**
- Add to `package.json`

### Long-term: schema denormalization

Add `taxon_lineage_ids` field to the `genome_feature` Solr schema. This eliminates the need for any join — `fq=taxon_lineage_ids:X` works directly on genome_feature. Requires schema migration and full reindex. The SQLite cache approach above is the bridge solution until this is done.

---

## Open Questions

- **How many API instances to run?** Fewer instances makes per-process admission control simpler to reason about. Node.js handles I/O-bound work well in a single process. 2 instances provides redundancy without coordination complexity.
- **HAProxy config access?** Can we modify the Solr backend config to add `retry-on 429`?
- **Client update scope?** Which CLI tools and website components need 429 support?
- **Rollout order?** Phase 1 (serializer throttling) can deploy immediately with no client changes. Phase 2 (admission control with 429) needs coordinated client updates.
- **Indexing-aware preference switching?** Implement Redis-based signaling between indexer and API for consistent reads during indexing window.
- **Schema denormalization**: When to add `taxon_lineage_ids` to genome_feature schema? This eliminates the join entirely but requires a full reindex.
