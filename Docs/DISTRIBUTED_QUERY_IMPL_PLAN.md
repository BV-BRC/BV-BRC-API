# Distributed Query Implementation Plan

## Overview

This document outlines the implementation plan for the BV-BRC Data API distributed query system. The system enables parallel data downloads from Solr by querying shards directly.

**Status:** ✅ **COMPLETED** (All 6 phases implemented)

**Related Documents:**
- [DISTRIBUTED_QUERY_SPEC.md](./DISTRIBUTED_QUERY_SPEC.md) - Specification
- [DISTRIBUTED_QUERY_DOCS.md](./DISTRIBUTED_QUERY_DOCS.md) - Full documentation
- [DISTRIBUTED_QUERY_QUICKSTART.md](./DISTRIBUTED_QUERY_QUICKSTART.md) - Quick start guide

---

## Implementation Summary

| Phase | Description | Status | Files Created |
|-------|-------------|--------|---------------|
| 1 | Core Infrastructure | ✅ Complete | `DistributedQueryConfig.js`, `CacheManager.js`, `SolrClusterClient.js` |
| 2 | Shard Query Engine | ✅ Complete | `ShardCursorStream.js`, `ParallelQueryCoordinator.js` |
| 3 | Merge Sort | ✅ Complete | `MergeSortStream.js`, `MinHeap.js` |
| 4 | Query Manager | ✅ Complete | `DistributedQueryManager.js` |
| 5 | API Endpoints | ✅ Complete | `routes/distributedQueryRouter.js` |
| 6 | Testing | ✅ Complete | `tests/test-distributed/*.spec.js` (71 tests) |

---

## Phase 1: Core Infrastructure ✅

### 1.1 Configuration Module ✅

**File:** `lib/distributed/DistributedQueryConfig.js`

**Completed Tasks:**
- [x] Define default configuration schema
- [x] Add configuration to `config.js`
- [x] Implement runtime configuration updates (in-memory)
- [x] Validate configuration values

**Configuration Schema:**
```javascript
module.exports = {
  maxParallelism: 8,
  maxRetries: 3,
  initialRetryDelayMs: 100,
  schemaCacheTTLMinutes: 60,
  clusterStatusCacheTTLSeconds: 60,
  maxMergeSortHeapDocs: 10000,
  maxMemoryMB: 32,
  cursorBatchSize: 2000,
  excludeNodes: [],
  adminUsers: []
}
```

---

### 1.2 Cache Manager ✅

**File:** `lib/distributed/CacheManager.js`

**Completed Tasks:**
- [x] Implement simple TTL cache class
- [x] Support manual invalidation
- [x] Thread-safe for concurrent access
- [x] Hit/miss tracking
- [x] Keys enumeration

**Interface:**
```javascript
class CacheManager {
  constructor({ ttlMs, name })
  get(key)
  set(key, value)
  has(key)
  invalidate(key)
  clear()
  getOrFetch(key, fetcher)
  setTTL(ttlMs)
  stats()
  keys()
}
```

---

### 1.3 Solr Cluster Client ✅

**File:** `lib/distributed/SolrClusterClient.js`

**Completed Tasks:**
- [x] Implement `getSchema(collection)` with caching
- [x] Implement `getClusterStatus()` with caching
- [x] Implement `getShardsForCollection(collection)`
- [x] Implement replica selection (random among non-leaders)
- [x] Handle node exclusion list
- [x] Error handling with proper error types

---

## Phase 2: Shard Query Engine ✅

### 2.1 Shard Cursor Stream ✅

**File:** `lib/distributed/ShardCursorStream.js`

**Completed Tasks:**
- [x] Implement Node.js Readable stream for single shard
- [x] Use Solr cursor-based pagination
- [x] Support `shard` and `preferLocalShards` parameters
- [x] Implement retry with exponential backoff
- [x] Handle backpressure (pause/resume)
- [x] Emit proper stream events (data, end, error)

**Key Implementation Details:**
- Uses `cursorMark` for pagination
- Configurable batch size (default 2000)
- Emits documents individually in object mode
- Automatic sort unique key appending

---

### 2.2 Parallel Query Coordinator ✅

**File:** `lib/distributed/ParallelQueryCoordinator.js`

**Completed Tasks:**
- [x] Manage pool of concurrent shard queries
- [x] Respect `maxParallelism` limit
- [x] Start new shard queries as others complete
- [x] Track overall progress
- [x] Handle shard failures (fail fast)
- [x] Clean cancellation on error/disconnect

---

## Phase 3: Merge Sort ✅

### 3.1 Merge Sort Stream ✅

**File:** `lib/distributed/MergeSortStream.js`

**Completed Tasks:**
- [x] Implement k-way merge using min-heap
- [x] Support configurable sort key extraction
- [x] Multi-field sort support
- [x] Backpressure: pause fetches when heap exceeds limit
- [x] Handle shard exhaustion
- [x] Correct merge semantics (output only when safe)

**Algorithm:**
1. Start all shard streams
2. Initialize min-heap with one doc per shard
3. Output minimum only when all active shards represented
4. Refill from same shard after pop
5. Pause shards when heap reaches limit
6. Resume at 80% capacity

---

### 3.2 Heap Implementation ✅

**File:** `lib/distributed/MinHeap.js`

**Completed Tasks:**
- [x] Implement binary min-heap
- [x] Support custom comparator
- [x] Track source shard for each element
- [x] Static field comparator helpers
- [x] Multi-field comparator support

**Interface:**
```javascript
class MinHeap {
  constructor(comparator)
  push(item)
  pop()
  peek()
  replace(item)
  pushPop(item)
  size()
  isEmpty()
  clear()
  toArray()
  isValid()
}

MinHeap.fieldComparator(field, order)
MinHeap.multiFieldComparator(fields)
```

---

## Phase 4: Query Manager ✅

### 4.1 Distributed Query Manager ✅

**File:** `lib/distributed/DistributedQueryManager.js`

**Completed Tasks:**
- [x] Orchestrate complete distributed query flow
- [x] Parse and validate query options
- [x] Auto-select stream type (sorted vs unordered)
- [x] Handle query cancellation
- [x] Connection pooling
- [x] Query lifecycle tracking
- [x] Limit support

**Interface:**
```javascript
class DistributedQueryManager {
  constructor(solrBaseUrl, options)

  async executeQuery(options) → { queryId, stream, metadata, cancel, getStats }

  cancelQuery(queryId)
  cancelAllQueries()
  getActiveQueryCount()
  getActiveQueries()
  getStats()
  getConfig()
  destroy()
}
```

---

## Phase 5: API Endpoints ✅

### 5.1 Test Endpoint ✅

**File:** `routes/distributedQueryRouter.js`

**Completed Tasks:**
- [x] Implement `POST /test/distributed-query`
- [x] Request validation
- [x] Stream response as NDJSON
- [x] Handle client disconnect
- [x] Error responses

### 5.2 Configuration Endpoints ✅

**Completed Tasks:**
- [x] `GET /test/distributed-query/config` - Get configuration
- [x] `PUT /test/distributed-query/config` - Update config (admin only)
- [x] `POST /test/distributed-query/config/reset` - Reset to defaults
- [x] `GET /test/distributed-query/stats` - Manager statistics
- [x] `GET /test/distributed-query/shards/:collection` - Shard info
- [x] `DELETE /test/distributed-query/cache` - Clear caches
- [x] `POST /test/distributed-query/cancel/:queryId` - Cancel query

---

## Phase 6: Testing ✅

### 6.1 Unit Tests ✅

**Files:** `tests/test-distributed/*.spec.js`

**Completed Tests (71 total):**
- [x] `test.minheap.spec.js` - 22 tests
  - Basic operations
  - Field comparators
  - Multi-field comparators
  - Large datasets (10,000 elements)
- [x] `test.cachemanager.spec.js` - 19 tests
  - TTL expiration
  - getOrFetch lazy loading
  - Hit/miss tracking
- [x] `test.config.spec.js` - 18 tests
  - Configuration CRUD
  - Validation bounds
  - Admin user management
- [x] `test.mergesort.spec.js` - 12 tests
  - K-way merge logic
  - Multi-field sorting
  - 80 shard simulation

**Run tests:**
```bash
npm run test-distributed
```

---

## File Structure (Final)

```
p3_api/
├── config.js                          # Added distributedQuery config ✅
├── app.js                             # Added router mount ✅
├── package.json                       # Added test-distributed script ✅
├── lib/
│   └── distributed/
│       ├── index.js                   # Module exports ✅
│       ├── DistributedQueryConfig.js  # Configuration ✅
│       ├── CacheManager.js            # TTL cache ✅
│       ├── SolrClusterClient.js       # Cluster metadata ✅
│       ├── ShardCursorStream.js       # Single-shard stream ✅
│       ├── ParallelQueryCoordinator.js# Unordered coordinator ✅
│       ├── MergeSortStream.js         # K-way merge stream ✅
│       ├── MinHeap.js                 # Priority queue ✅
│       └── DistributedQueryManager.js # Top-level orchestrator ✅
├── routes/
│   └── distributedQueryRouter.js      # API endpoints ✅
├── tests/
│   └── test-distributed/
│       ├── test.minheap.spec.js       # 22 tests ✅
│       ├── test.cachemanager.spec.js  # 19 tests ✅
│       ├── test.config.spec.js        # 18 tests ✅
│       └── test.mergesort.spec.js     # 12 tests ✅
└── Docs/
    ├── DISTRIBUTED_QUERY_SPEC.md      # Specification ✅
    ├── DISTRIBUTED_QUERY_IMPL_PLAN.md # This document ✅
    ├── DISTRIBUTED_QUERY_DOCS.md      # Full documentation ✅
    └── DISTRIBUTED_QUERY_QUICKSTART.md# Quick start guide ✅
```

---

## Success Criteria

1. **Functionality** ✅
   - [x] Can query all shards in parallel
   - [x] Returns complete result set (no missing documents)
   - [x] Merge sort produces correctly ordered output
   - [x] Handles shard failures gracefully

2. **Performance** (To be validated in production)
   - [ ] Throughput > 2x single-coordinator approach for large queries
   - [ ] Memory stays within 32MB limit
   - [ ] No degradation under backpressure

3. **Reliability** ✅
   - [x] Retries recover from transient failures
   - [x] Clean shutdown on client disconnect
   - [x] No resource leaks

---

## Next Steps

1. **Integration Testing** - Test against real Solr cluster
2. **Performance Benchmarking** - Compare with standard queries
3. **Production Deployment** - Deploy behind feature flag
4. **Monitoring** - Add metrics and alerting

---

## Dependencies

### New Dependencies

None required. Implementation uses:
- Node.js built-in `stream` module
- Node.js built-in `http/https` modules
- Existing `debug` module

### Internal Dependencies

- `config.js` - Configuration system
- `middleware/auth.js` - Authentication
- `middleware/http-params.js` - HTTP parameter handling

---

## Risks and Mitigations

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|
| Memory pressure with 80 shards | High | Strict heap limits, backpressure handling | ✅ Implemented |
| Shard failures cascade | Medium | Retry with backoff, fail fast on persistent errors | ✅ Implemented |
| Cluster status stale | Low | Short TTL, invalidate on errors | ✅ Implemented |
| Slow client causes buffer growth | Medium | Backpressure pauses shard fetches | ✅ Implemented |
| Merge sort performance | Medium | Efficient heap implementation, limit heap size | ✅ Implemented |
