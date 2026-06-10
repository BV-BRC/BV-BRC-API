# Distributed Query Specification

## Overview

This document specifies a parallel data download system for the BV-BRC Data API that queries Solr shards directly and in parallel, improving performance for large sharded collections.

## Motivation

Large BV-BRC collections are sharded across multiple Solr nodes. The standard query path routes through a single coordinator, which becomes a bottleneck for large data downloads. By querying shards directly and in parallel, we can significantly improve throughput.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Request                               │
│  POST /test/distributed-query                                        │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    DistributedQueryManager                          │
│  • Schema cache (60 min TTL)                                        │
│  • Cluster status cache (60 sec TTL)                                │
│  • Parallelism control                                              │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
            ┌────────────┐ ┌────────────┐ ┌────────────┐
            │ ShardCursor│ │ ShardCursor│ │ ShardCursor│
            │ (replica)  │ │ (replica)  │ │ (replica)  │
            └────────────┘ └────────────┘ └────────────┘
                    │              │              │
                    └──────────────┼──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │  MergeSortStream (optional) │
                    │  or UnorderedStream         │
                    └─────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Node.js Readable Stream    │
                    │  (for downstream processing)│
                    └─────────────────────────────┘
```

## Core Components

### 1. Schema Retrieval

Fetch collection schema from Solr:

```
GET /solr/{collection}/schema
```

**Caching:** 60 minute TTL

### 2. Cluster Status Retrieval

Fetch cluster topology to identify available shards and replicas:

```
GET /solr/admin/collections?action=clusterstatus
```

**Caching:** 60 second TTL (topology may change)

**Reference:** https://solr.apache.org/guide/8_8/cluster-node-management.html#clusterstatus-response

### 3. Replica Selection

For each shard, select a replica to query:

- Filter to `active` replicas only
- Prefer non-leader replicas (reduce leader load)
- Exclude known problematic nodes (configurable exclusion list)
- Use **random selection** among candidates to spread load

### 4. Distributed Query Execution

Execute queries across all shards in parallel:

- **Parallelism:** Configurable number of concurrent shard queries
- **Cursor-based pagination:** Each shard query uses Solr cursors
- **Shard targeting:** Parameters `shard={shardname}&preferLocalShards=true`
- **Query format:** RQL or raw Solr syntax supported
- **Field selection:** `select()` supported to limit returned fields

## Configuration

### Default Configuration (config.js)

```javascript
{
  distributedQuery: {
    // Maximum concurrent shard queries
    maxParallelism: 8,

    // Retry configuration
    maxRetries: 3,
    initialRetryDelayMs: 100,  // Exponential backoff: 100ms, 200ms, 400ms

    // Cache TTLs
    schemaCacheTTLMinutes: 60,
    clusterStatusCacheTTLSeconds: 60,

    // Memory limits
    maxMergeSortHeapDocs: 10000,
    maxMemoryMB: 32,

    // Node exclusion list (regex patterns)
    excludeNodes: [],

    // Admin users who can modify runtime config
    adminUsers: []
  }
}
```

### Runtime Configuration API

```
POST /admin/config
Authorization: Bearer {token}
Content-Type: application/json

{
  "distributedQuery": {
    "maxParallelism": 12
  }
}
```

**Access Control:** Only authenticated users listed in `config.distributedQuery.adminUsers`

## Query Modes

### Unordered Mode (default)

- Drain shards as fast as possible
- Results arrive in arbitrary order (interleaved from multiple shards)
- Lowest latency, highest throughput
- Memory efficient (no buffering required)

### Merge Sort Mode (optional)

- Results sorted across all shards by specified sort key
- Uses k-way merge with priority queue (heap)
- Round-robin fetch from shards to manage memory
- **Backpressure handling:** Pause shard fetches when heap exceeds 10,000 documents
- **Memory limit:** 32MB total for shard buffers

## Error Handling

### Shard Query Failure

1. Retry with exponential backoff: 100ms → 200ms → 400ms
2. Maximum 3 retry attempts (configurable)
3. If shard continues to fail, **fail the entire distributed query**
4. On failure, invalidate cluster status cache (topology may have changed)

### Client Disconnection

- Detect client disconnect via stream events
- Cancel all in-flight shard queries
- Clean up resources

## API

### Test Endpoint

```
POST /test/distributed-query
Content-Type: application/json

{
  "collection": "genome_feature",
  "query": "eq(genome_id,83332.12)",
  "sort": "+feature_id",
  "mergeSort": true,
  "limit": 1000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | Yes | Solr collection name |
| `query` | string | Yes | RQL or Solr query |
| `sort` | string | No | Sort specification (required if `mergeSort: true`) |
| `mergeSort` | boolean | No | Enable merge sort (default: false) |
| `limit` | integer | No | Maximum documents to return |

### Response

Streaming JSON array:

```
Content-Type: application/json
Transfer-Encoding: chunked

[
  {"genome_id": "83332.12", "feature_id": "...", ...},
  {"genome_id": "83332.12", "feature_id": "...", ...},
  ...
]
```

## Integration

### Node.js Stream Interface

The distributed query mechanism exports results as a Node.js Readable stream in object mode:

```javascript
const stream = distributedQuery.createStream({
  collection: 'genome_feature',
  query: 'eq(genome_id,83332.12)',
  sort: '+feature_id',
  mergeSort: true
});

// Pipe to downstream processors
stream
  .pipe(postProcessTransform)
  .pipe(formatAsTabular)
  .pipe(response);
```

### Downstream Processing Examples

- Reformatting to tabular form (TSV/CSV)
- Reformatting sequence data as FASTA
- Reformatting to GFF or GenBank format
- Joining with results from other queries

## Constraints

| Constraint | Value |
|------------|-------|
| Maximum shards | 80 |
| Maximum memory | 32 MB |
| Maximum merge sort heap | 10,000 documents |
| Schema cache TTL | 60 minutes |
| Cluster status cache TTL | 60 seconds |
| Default parallelism | 8 concurrent shard queries |
| Default max retries | 3 |

## Future Considerations

- Integration with existing query endpoints (deferred)
- Shard-aware query routing based on sharding keys
- Health-based replica selection
- Metrics and monitoring
