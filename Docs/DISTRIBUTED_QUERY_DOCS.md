# Distributed Query System

The BV-BRC API distributed query system enables parallel data retrieval from Solr sharded collections. It queries shards directly and concurrently, providing significant performance improvements for large result sets.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Usage Examples](#usage-examples)
- [Components](#components)
- [Performance Considerations](#performance-considerations)
- [Troubleshooting](#troubleshooting)

---

## Overview

### Problem Statement

Standard Solr queries route through a coordinator node that:
1. Fans out requests to all shards
2. Collects and merges results
3. Returns the final response

For large result sets (100K+ documents), this creates bottlenecks:
- Memory pressure on the coordinator
- Network congestion as all data flows through one node
- Timeout risks for slow queries

### Solution

The distributed query system:
1. Discovers shard topology from Solr cluster status
2. Queries each shard directly using cursor-based pagination
3. Streams results back to the client in real-time
4. Optionally merge-sorts results for globally ordered output

### Key Features

- **Parallel Execution**: Query up to 80 shards concurrently (configurable parallelism)
- **Streaming Output**: Results stream as they arrive, no buffering entire result set
- **Cursor Pagination**: Efficient deep pagination using Solr's cursorMark
- **Sorted Output**: K-way merge sort for globally ordered results
- **Memory Bounded**: Configurable limits prevent OOM conditions
- **Fault Tolerance**: Exponential backoff retry on transient failures
- **Backpressure**: Automatic flow control when consumer is slow

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Request                                  │
│              POST /test/distributed-query                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 DistributedQueryManager                          │
│  • Query planning and validation                                 │
│  • Stream type selection (sorted vs unordered)                   │
│  • Connection pooling                                            │
│  • Query lifecycle management                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SolrClusterClient                             │
│  • Cluster topology discovery                                    │
│  • Schema caching (60 min TTL)                                   │
│  • Shard/replica selection                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Shard 1     │    │  Shard 2     │    │  Shard N     │
│  Replica     │    │  Replica     │    │  Replica     │
└──────────────┘    └──────────────┘    └──────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ShardCursor   │    │ShardCursor   │    │ShardCursor   │
│Stream        │    │Stream        │    │Stream        │
└──────────────┘    └──────────────┘    └──────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
         ┌────────────────────────────────────────┐
         │  ParallelQueryCoordinator (unordered)  │
         │              OR                        │
         │  MergeSortStream (sorted)              │
         └────────────────────────────────────────┘
                              │
                              ▼
         ┌────────────────────────────────────────┐
         │         Streaming Response             │
         │      (newline-delimited JSON)          │
         └────────────────────────────────────────┘
```

### Component Overview

| Component | Purpose |
|-----------|----------|
| `DistributedQueryManager` | Top-level orchestrator, query lifecycle |
| `SolrClusterClient` | Cluster metadata, shard discovery |
| `ShardCursorStream` | Single-shard cursor pagination |
| `ParallelQueryCoordinator` | Concurrent unordered queries |
| `MergeSortStream` | K-way merge for sorted output |
| `MinHeap` | Priority queue for merge sort |
| `CacheManager` | TTL-based caching |
| `DistributedQueryConfig` | Runtime configuration |

---

## Configuration

### Config File Settings

Add to `p3api.conf`:

```javascript
{
  "distributedQuery": {
    "maxParallelism": 8,           // Max concurrent shard queries
    "maxRetries": 3,               // Retry attempts per shard
    "initialRetryDelayMs": 100,    // Base delay for exponential backoff
    "schemaCacheTTLMinutes": 60,   // Schema cache lifetime
    "clusterStatusCacheTTLSeconds": 60,  // Cluster status cache
    "maxMergeSortHeapDocs": 10000, // Max docs in merge sort heap
    "maxMemoryMB": 32,             // Memory limit (advisory)
    "cursorBatchSize": 2000,       // Docs per cursor request
    "excludeNodes": [],            // Regex patterns to exclude nodes
    "adminUsers": ["admin@patricbrc.org"]  // Users who can modify config
  }
}
```

### Configuration Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `maxParallelism` | number | 8 | 1-100 | Maximum concurrent shard queries |
| `maxRetries` | number | 3 | 0-10 | Retry attempts before failing |
| `initialRetryDelayMs` | number | 100 | 10-10000 | Base delay for exponential backoff |
| `schemaCacheTTLMinutes` | number | 60 | - | How long to cache collection schemas |
| `clusterStatusCacheTTLSeconds` | number | 60 | - | How long to cache cluster topology |
| `maxMergeSortHeapDocs` | number | 10000 | 100-100000 | Max documents in merge heap |
| `maxMemoryMB` | number | 32 | - | Advisory memory limit |
| `cursorBatchSize` | number | 2000 | 100-10000 | Documents per Solr request |
| `excludeNodes` | string[] | [] | - | Regex patterns for excluded nodes |
| `adminUsers` | string[] | [] | - | Users authorized to modify config |

### Runtime Configuration Updates

Admins can update configuration at runtime via the API:

```bash
# Update parallelism
curl -X PUT http://localhost:3001/test/distributed-query/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"maxParallelism": 16}'

# Reset to defaults
curl -X POST http://localhost:3001/test/distributed-query/config/reset \
  -H "Authorization: Bearer $TOKEN"
```

---

## API Reference

### POST /test/distributed-query

Execute a distributed query.

**Request Body:**

```json
{
  "collection": "genome_feature",
  "query": "fq=genome_id:123&fq=feature_type:CDS",
  "queryType": "solr",
  "sort": "patric_id asc",
  "fields": "patric_id,product,start,end",
  "limit": 10000,
  "requireSorted": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | Yes | Solr collection name |
| `query` | string | Yes | Query in Solr format (fq=...) |
| `queryType` | string | No | `"solr"` (default) or `"rql"` |
| `sort` | string | No | Sort specification (e.g., `"field asc"`) |
| `fields` | string | No | Comma-separated field list |
| `limit` | number | No | Maximum documents (0 = unlimited) |
| `requireSorted` | boolean | No | Force sorted output |

**Response:**

Streams newline-delimited JSON (NDJSON):

```
{"patric_id":"fig|123.1.peg.1","product":"hypothetical protein"}
{"patric_id":"fig|123.1.peg.2","product":"DNA polymerase"}
{"patric_id":"fig|123.1.peg.3","product":"RNA helicase"}
{"_meta":{"queryId":1,"documentCount":3,"elapsedMs":245,"streamType":"parallel","shardCount":4}}
```

**Response Headers:**

| Header | Description |
|--------|-------------|
| `X-Query-Id` | Unique query identifier |
| `X-Stream-Type` | `"parallel"` or `"merge-sort"` |
| `X-Shard-Count` | Number of shards queried |

---

### GET /test/distributed-query/config

Get current and default configuration.

**Response:**

```json
{
  "current": {
    "maxParallelism": 8,
    "maxRetries": 3,
    "initialRetryDelayMs": 100,
    "schemaCacheTTLMinutes": 60,
    "clusterStatusCacheTTLSeconds": 60,
    "maxMergeSortHeapDocs": 10000,
    "maxMemoryMB": 32,
    "cursorBatchSize": 2000,
    "excludeNodes": [],
    "adminUsers": []
  },
  "defaults": { ... }
}
```

---

### PUT /test/distributed-query/config

Update configuration (admin only).

**Request Body:**

```json
{
  "maxParallelism": 16,
  "cursorBatchSize": 5000
}
```

**Response:**

```json
{
  "success": true,
  "config": { ... }
}
```

---

### POST /test/distributed-query/config/reset

Reset configuration to defaults (admin only).

---

### GET /test/distributed-query/stats

Get manager statistics.

**Response:**

```json
{
  "initialized": true,
  "stats": {
    "activeQueries": 2,
    "totalQueriesExecuted": 150,
    "cacheStats": {
      "schema": { "size": 5, "hits": 120, "misses": 5 },
      "clusterStatus": { "size": 1, "hits": 145, "misses": 5 }
    }
  },
  "activeQueries": [
    {
      "queryId": 149,
      "collection": "genome_feature",
      "streamType": "parallel",
      "elapsedMs": 1234
    }
  ]
}
```

---

### GET /test/distributed-query/shards/:collection

Get shard information for a collection.

**Response:**

```json
{
  "collection": "genome_feature",
  "shardCount": 4,
  "shards": [
    {
      "shard": "shard1",
      "replica": {
        "name": "core_node1",
        "core": "genome_feature_shard1_replica_n1",
        "base_url": "http://solr1:8983/solr",
        "state": "active",
        "leader": "false"
      }
    }
  ]
}
```

---

### POST /test/distributed-query/cancel/:queryId

Cancel an active query.

**Response:**

```json
{
  "success": true,
  "message": "Query 42 cancelled"
}
```

---

### DELETE /test/distributed-query/cache

Clear all caches (admin only).

---

## Usage Examples

### Basic Query

```bash
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "collection": "genome_feature",
    "query": "fq=genome_id:83332.12",
    "fields": "patric_id,product,start,end,strand"
  }'
```

### Sorted Query

```bash
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "collection": "genome_feature",
    "query": "fq=genome_id:83332.12&fq=feature_type:CDS",
    "sort": "start asc",
    "fields": "patric_id,product,start,end"
  }'
```

### Limited Results

```bash
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{
    "collection": "genome",
    "query": "fq=taxon_lineage_ids:773",
    "sort": "genome_name asc",
    "limit": 100
  }'
```

### Programmatic Usage (Node.js)

```javascript
const { DistributedQueryManager } = require('./lib/distributed')

const manager = new DistributedQueryManager('http://localhost:8983/solr')

async function queryGenomes() {
  const result = await manager.executeQuery({
    collection: 'genome_feature',
    query: 'fq=genome_id:83332.12',
    sort: 'start asc',
    fields: 'patric_id,product',
    limit: 1000
  })

  console.log(`Query ${result.queryId}: ${result.metadata.shardCount} shards`)

  const docs = []

  for await (const doc of result.stream) {
    docs.push(doc)
  }

  console.log(`Retrieved ${docs.length} documents`)
  return docs
}

// With cancellation
async function queryWithTimeout() {
  const result = await manager.executeQuery({ ... })

  setTimeout(() => {
    result.cancel()
  }, 30000)  // Cancel after 30 seconds

  // Process stream...
}
```

---

## Components

### DistributedQueryManager

The main entry point for distributed queries.

```javascript
const manager = new DistributedQueryManager(solrBaseUrl, options)
```

**Options:**
- `httpAgent` - HTTP agent for connection pooling
- `httpsAgent` - HTTPS agent for connection pooling

**Methods:**

| Method | Description |
|--------|-------------|
| `executeQuery(options)` | Execute a distributed query |
| `cancelQuery(queryId)` | Cancel an active query |
| `cancelAllQueries()` | Cancel all active queries |
| `getActiveQueryCount()` | Get number of active queries |
| `getActiveQueries()` | Get info about active queries |
| `getStats()` | Get manager statistics |
| `getConfig()` | Get current configuration |
| `destroy()` | Clean up resources |

---

### SolrClusterClient

Handles Solr cluster metadata.

```javascript
const client = new SolrClusterClient(solrBaseUrl, options)
```

**Methods:**

| Method | Description |
|--------|-------------|
| `getSchema(collection)` | Get collection schema (cached) |
| `getUniqueKey(collection)` | Get unique key field name |
| `getClusterStatus()` | Get cluster topology (cached) |
| `getShardsForCollection(collection)` | Get shard/replica info |
| `getReplicaQueryUrl(replica)` | Build direct query URL |
| `invalidateClusterStatus()` | Clear cluster cache |
| `clearCaches()` | Clear all caches |

**Replica Selection:**

1. Filters to active replicas only
2. Excludes nodes matching `excludeNodes` patterns
3. Prefers non-leader replicas (to reduce leader load)
4. Randomly selects among equivalent candidates

---

### ShardCursorStream

Node.js Readable stream for a single shard.

```javascript
const stream = new ShardCursorStream({
  solrUrl: 'http://solr1:8983/solr/collection_shard1',
  shard: 'shard1',
  query: 'fq=genome_id:123',
  sort: 'id asc',
  fields: 'id,name',
  uniqueKey: 'id'
})

stream.on('data', (doc) => console.log(doc))
stream.on('end', () => console.log('Done'))
```

**Features:**
- Cursor-based pagination (no offset/limit)
- Automatic retry with exponential backoff
- Backpressure support
- Direct shard querying with `preferLocalShards=true`

---

### ParallelQueryCoordinator

Manages concurrent unordered queries across shards.

```javascript
const coordinator = new ParallelQueryCoordinator({
  shardConfigs: [...],
  query: 'fq=genome_id:123',
  fields: 'id,name'
})
```

**Behavior:**
- Starts up to `maxParallelism` shard queries
- Rotates to next shard as each completes
- Fails fast on any shard error
- Output order is non-deterministic

---

### MergeSortStream

K-way merge sort for globally sorted output.

```javascript
const stream = new MergeSortStream({
  shardConfigs: [...],
  query: 'fq=genome_id:123',
  sort: 'start asc, id asc',
  fields: 'id,start,end'
})
```

**Algorithm:**
1. Starts all shard streams concurrently
2. Maintains a min-heap of documents (one per active shard minimum)
3. Outputs minimum only when all active shards have contributed
4. Pauses shards when heap reaches `maxMergeSortHeapDocs`
5. Resumes shards when heap drops below 80% capacity

**Correctness Guarantee:**
A document is only emitted when we can prove no smaller document can arrive from any active shard.

---

### MinHeap

Binary min-heap for merge sort.

```javascript
const heap = new MinHeap((a, b) => a.score - b.score)
heap.push({ score: 10 })
heap.push({ score: 5 })
heap.pop()  // { score: 5 }
```

**Static Methods:**

```javascript
// Single field comparator
const cmp = MinHeap.fieldComparator('score', 'desc')

// Multi-field comparator
const cmp = MinHeap.multiFieldComparator([
  { field: 'category', order: 'asc' },
  { field: 'score', order: 'desc' }
])
```

---

### CacheManager

TTL-based cache for expensive data.

```javascript
const cache = new CacheManager({ ttlMs: 60000, name: 'schema' })

// Simple get/set
cache.set('key', value)
cache.get('key')

// Lazy loading
const value = await cache.getOrFetch('key', async () => {
  return await expensiveOperation()
})
```

---

## Performance Considerations

### When to Use Distributed Queries

| Scenario | Recommendation |
|----------|----------------|
| < 10,000 results | Standard Solr query (simpler) |
| 10,000 - 100,000 results | Distributed query beneficial |
| > 100,000 results | Distributed query recommended |
| Export/download | Distributed query ideal |
| Real-time search | Standard Solr (lower latency) |

### Tuning Parameters

**maxParallelism:**
- Higher values → faster total time, more memory
- Lower values → slower but more predictable
- Rule of thumb: 2-4x number of CPU cores

**cursorBatchSize:**
- Larger batches → fewer round trips, more memory
- Smaller batches → more round trips, lower memory
- Typical: 1000-5000

**maxMergeSortHeapDocs:**
- Must hold at least one doc per shard
- Higher values → smoother output, more memory
- Lower values → more pausing, lower memory

### Memory Usage

Approximate memory per query:

```
Memory ≈ (maxParallelism × cursorBatchSize × avgDocSize) +
         (maxMergeSortHeapDocs × avgDocSize)
```

With defaults (8 parallel, 2000 batch, 10000 heap, 1KB docs):
```
Memory ≈ (8 × 2000 × 1KB) + (10000 × 1KB) = 26MB per query
```

### Network Efficiency

- Connection pooling reuses TCP connections
- `preferLocalShards=true` routes to local replica when possible
- Cursor pagination avoids deep offset penalties

---

## Troubleshooting

### Common Issues

**"No available shards for collection"**
- Check that the collection exists
- Verify cluster status shows active replicas
- Check if `excludeNodes` patterns are too broad

**Timeout errors**
- Increase `cursorBatchSize` to reduce round trips
- Check Solr node health
- Reduce query complexity

**Out of memory**
- Reduce `maxParallelism`
- Reduce `maxMergeSortHeapDocs`
- Reduce `cursorBatchSize`
- Add a `limit` to queries

**Incorrect sort order (merge sort)**
- Ensure sort field exists in all documents
- Check for null values (sorted last by default)
- Verify sort specification syntax

### Debugging

Enable debug logging:

```bash
DEBUG=p3api-server:distributed:* npm start
```

Specific components:
```bash
DEBUG=p3api-server:distributed:manager npm start
DEBUG=p3api-server:distributed:shard-cursor npm start
DEBUG=p3api-server:distributed:merge-sort npm start
DEBUG=p3api-server:distributed:coordinator npm start
DEBUG=p3api-server:distributed:cluster npm start
DEBUG=p3api-server:distributed:cache npm start
```

### Monitoring

Check active queries:
```bash
curl http://localhost:3001/test/distributed-query/stats
```

Check cache health:
```bash
curl http://localhost:3001/test/distributed-query/stats | jq '.stats.cacheStats'
```

### Recovery

**Clear caches after topology change:**
```bash
curl -X DELETE http://localhost:3001/test/distributed-query/cache \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Cancel stuck queries:**
```bash
curl -X POST http://localhost:3001/test/distributed-query/cancel/42 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Testing

Run unit tests:

```bash
npm run test-distributed
```

Tests cover:
- MinHeap operations and comparators
- CacheManager TTL and lazy loading
- Configuration validation
- K-way merge sort logic

---

## Future Enhancements

Potential improvements:

1. **Aggregation support** - Distributed faceting and stats
2. **Query caching** - Cache common query results
3. **Adaptive parallelism** - Auto-tune based on cluster load
4. **Shard affinity** - Route similar queries to same replicas
5. **Progress reporting** - Real-time progress updates
6. **Result sampling** - Statistical sampling for large datasets
