# Valkey Caching Layer Implementation Plan

## BV-BRC API (p3api) - Query Acceleration Architecture

**Document Version:** 1.0
**Date:** February 2026
**Status:** Proposal

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Proposed Architecture](#proposed-architecture)
4. [Implementation Phases](#implementation-phases)
5. [Technical Specifications](#technical-specifications)
6. [Cache Key Design](#cache-key-design)
7. [TTL Strategy](#ttl-strategy)
8. [Cache Invalidation](#cache-invalidation)
9. [Configuration](#configuration)
10. [Monitoring & Metrics](#monitoring--metrics)
11. [Migration Path](#migration-path)
12. [Risk Assessment](#risk-assessment)

---

## Executive Summary

This document outlines a plan to implement a Valkey (Redis-compatible) caching layer in front of Solr queries for the BV-BRC API. The goal is to reduce Solr load, decrease query latency, and improve API throughput for repeated queries.

### Key Benefits

| Metric | Current | Projected |
|--------|---------|-----------|
| Query Latency (cache hit) | 50-500ms | 1-5ms |
| Solr Load | 100% | 40-60% (estimated) |
| Cache Hit Rate | ~0% (main queries) | 40-70% |
| Concurrent Capacity | Solr-limited | 3-5x improvement |

### Why Valkey?

Valkey is a Redis-compatible, open-source in-memory data store that provides:
- Drop-in replacement for Redis (same protocol)
- Apache 2.0 license (no licensing concerns)
- Active community development
- Cluster mode for horizontal scaling
- Built-in TTL and eviction policies

---

## Current State Analysis

### Existing Caching Mechanisms

#### 1. File-Based Cache (UNUSED)

**Files:** `cache.js`, `middleware/cache.js`

```
cache.js
├── get(key, options)    → Read from filesystem
├── put(key, data, options) → Write to filesystem
└── User isolation via directory structure: {CACHE_DIR}/{user}/{md5_hash}
```

**Status:** Implemented but NOT integrated into dataType.js middleware chain.

**Limitations:**
- Disk I/O latency (~1-10ms per operation)
- No automatic TTL expiration
- No distributed/cluster support
- Manual cleanup required
- Race conditions on concurrent writes

#### 2. Redis/apicache (ACTIVE - Limited Scope)

**File:** `routes/dataRouter.js`

Currently used for 3 summary endpoints only:
- `/data/summary_by_taxon/:taxon_id` (1 day TTL)
- `/data/distinct/:collection/:field` (1 day TTL)
- `/data/subsystem_summary/:genome_id` (1 day TTL)

**Current Redis Config:**
```javascript
// routes/dataRouter.js:13-15
const redisOptions = config.get('redis')
const cacheWithRedis = apicache.options({
  redisClient: redis.createClient(redisOptions)
}).middleware
```

#### 3. In-Memory Per-Request Cache (ACTIVE)

**File:** `middleware/ExpandingQuery.js`

Used for RQL query expansion within a single request:
```javascript
// Prevents re-executing same subqueries within single request
req.queryCache = req.queryCache || {}
```

**Scope:** Single request only, not persistent.

### Main Query Flow (NO CACHING)

```
routes/dataType.js middleware chain:
┌─────────────────┐
│   http-params   │ ─► Parse URL parameters
├─────────────────┤
│      auth       │ ─► Validate JWT tokens
├─────────────────┤
│ PublicDataTypes │ ─► Set public collection list
├─────────────────┤
│ RQLQueryParser  │ ─► Convert RQL → Solr
├─────────────────┤
│  DecorateQuery  │ ─► Add user permission filters
├─────────────────┤
│     Limiter     │ ─► Enforce row limits
├─────────────────┤
│ShardsPreference │ ─► Set shard routing
├─────────────────┤
│ streamingCheck  │ ─► Detect large downloads
├─────────────────┤
│APIMethodHandler │ ─► Execute Solr query ◄── NO CACHE
├─────────────────┤
│   reqCounter    │ ─► Track statistics
├─────────────────┤
│ExtractCustomFlds│ ─► Map field names
├─────────────────┤
│  ContentRange   │ ─► Set HTTP headers
├─────────────────┤
│     media       │ ─► Format response
└─────────────────┘
```

---

## Proposed Architecture

### High-Level Design

```
                                    ┌─────────────────┐
                                    │   Valkey Cache  │
                                    │    (Primary)    │
                                    └────────┬────────┘
                                             │
┌──────────┐    ┌──────────────┐    ┌────────▼────────┐    ┌──────────────┐
│  Client  │───►│  Express App │───►│  Cache Layer    │───►│    Solr      │
│          │◄───│              │◄───│  Middleware     │◄───│   Backend    │
└──────────┘    └──────────────┘    └─────────────────┘    └──────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │ Valkey Replica  │
                                    │   (Optional)    │
                                    └─────────────────┘
```

### Middleware Integration Point

Insert cache middleware AFTER query decoration (permissions applied) and BEFORE Solr execution:

```
Current:
  DecorateQuery → Limiter → ShardsPreference → streamCheck → APIMethodHandler

Proposed:
  DecorateQuery → Limiter → ShardsPreference → ValkeyCacheGet → streamCheck → APIMethodHandler → ValkeyCachePut
```

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           valkey-cache/                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   client.js      │  │   keyGenerator.js │  │   ttlStrategy.js    │  │
│  │                  │  │                   │  │                     │  │
│  │ • Connection     │  │ • Hash generation │  │ • Per-collection    │  │
│  │ • Reconnection   │  │ • User isolation  │  │ • Public vs private │  │
│  │ • Error handling │  │ • Normalization   │  │ • Query complexity  │  │
│  └──────────────────┘  └───────────────────┘  └─────────────────────┘  │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │   middleware/    │  │   metrics.js     │  │   invalidation.js   │  │
│  │   get.js         │  │                  │  │                     │  │
│  │   put.js         │  │ • Hit/miss rates │  │ • Tag-based delete  │  │
│  │                  │  │ • Latency stats  │  │ • Pattern delete    │  │
│  │ • Cache lookup   │  │ • Memory usage   │  │ • Manual purge API  │  │
│  │ • Cache storage  │  │ • Key counts     │  │                     │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Goal:** Establish Valkey infrastructure and basic caching for public queries.

#### Tasks:

1. **Add Valkey client dependency**
   ```bash
   npm install ioredis
   ```

2. **Create Valkey client module** (`valkey-cache/client.js`)
   - Connection management
   - Reconnection logic
   - Error handling
   - Health checks

3. **Implement cache key generator** (`valkey-cache/keyGenerator.js`)
   - Deterministic key generation
   - User isolation for private data
   - Query normalization

4. **Create cache middleware** (`valkey-cache/middleware.js`)
   - GET: Check cache before Solr
   - PUT: Store results after Solr

5. **Update configuration** (`p3api.conf`)
   - Valkey connection settings
   - TTL defaults
   - Feature flags

6. **Integrate into dataType.js**
   - Insert middleware into chain
   - Conditional enablement

#### Deliverables:
- [ ] Valkey client module
- [ ] Cache middleware (get/put)
- [ ] Configuration updates
- [ ] Unit tests
- [ ] Integration with public queries

### Phase 2: Private Data & TTL Strategy (Week 3-4)

**Goal:** Handle user-specific caching and implement collection-aware TTLs.

#### Tasks:

1. **Implement user-aware caching**
   - Cache key includes user ID for private collections
   - Separate cache namespaces per user

2. **Create TTL strategy module** (`valkey-cache/ttlStrategy.js`)
   - Per-collection TTL configuration
   - Public vs private TTL differences
   - Query complexity factors

3. **Add cache bypass conditions**
   - Streaming queries (already handled)
   - Write operations
   - Admin operations
   - Large result sets (configurable threshold)

4. **Implement schema caching**
   - Long TTL for Solr schemas
   - Separate cache key space

#### Deliverables:
- [ ] User-aware cache keys
- [ ] Collection-specific TTLs
- [ ] Cache bypass logic
- [ ] Schema caching

### Phase 3: Cache Invalidation (Week 5-6)

**Goal:** Implement cache invalidation strategies for data consistency.

#### Tasks:

1. **Tag-based invalidation**
   - Tag cache entries with genome_id, collection
   - Delete by tag on data mutation

2. **Implement invalidation API**
   - Admin endpoint to purge cache
   - Pattern-based deletion

3. **Hook into genome permission changes**
   - Invalidate affected user caches
   - File: `routes/genomePermissionRouter.js`

4. **Version-based cache keys (optional)**
   - Include collection version in key
   - Auto-invalidate on version bump

#### Deliverables:
- [ ] Tag-based cache invalidation
- [ ] Admin purge API
- [ ] Permission change hooks
- [ ] Documentation

### Phase 4: Monitoring & Optimization (Week 7-8)

**Goal:** Add observability and optimize cache performance.

#### Tasks:

1. **Implement cache metrics**
   - Hit/miss rates per collection
   - Latency percentiles
   - Memory usage tracking
   - Key count by namespace

2. **Add health endpoint**
   - Valkey connectivity check
   - Memory utilization
   - Connection pool status

3. **Performance tuning**
   - Connection pooling optimization
   - Batch operations where applicable
   - Compression for large payloads

4. **Documentation**
   - Operations runbook
   - Troubleshooting guide
   - Configuration reference

#### Deliverables:
- [ ] Metrics endpoint
- [ ] Health check integration
- [ ] Performance benchmarks
- [ ] Operations documentation

---

## Technical Specifications

### Valkey Connection Configuration

```javascript
// valkey-cache/client.js
const Redis = require('ioredis')

const defaultConfig = {
  host: '127.0.0.1',
  port: 6379,
  db: 1,                    // Separate from existing apicache (db: 2)
  password: null,           // Set in production
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  enableReadyCheck: true,
  lazyConnect: false,
  // Connection pool settings
  connectionName: 'p3api-valkey-cache',
  keepAlive: 10000,
}

// Cluster mode (optional, for production scale)
const clusterConfig = {
  nodes: [
    { host: 'valkey-1', port: 6379 },
    { host: 'valkey-2', port: 6379 },
    { host: 'valkey-3', port: 6379 },
  ],
  redisOptions: {
    password: process.env.VALKEY_PASSWORD,
  },
  scaleReads: 'slave',  // Read from replicas
}
```

### Cache Middleware Implementation

```javascript
// valkey-cache/middleware.js
const debug = require('debug')('p3api-server:valkey-cache')
const client = require('./client')
const keyGenerator = require('./keyGenerator')
const ttlStrategy = require('./ttlStrategy')
const config = require('../config')

const isEnabled = config.get('valkey')?.enable ?? false
const maxCacheSize = config.get('valkey')?.maxResultSize ?? 10 * 1024 * 1024 // 10MB

/**
 * Cache GET middleware - check cache before Solr query
 */
module.exports.get = async function (req, res, next) {
  // Skip if disabled or streaming
  if (!isEnabled || req.call_method === 'stream') {
    return next()
  }

  const startTime = Date.now()

  try {
    const cacheKey = keyGenerator.generate(req)
    req.cacheKey = cacheKey

    const cached = await client.get(cacheKey)

    if (cached) {
      req.cacheHit = true
      res.results = JSON.parse(cached)
      debug(`CACHE HIT [${Date.now() - startTime}ms]: ${cacheKey.substring(0, 32)}...`)

      // Track metrics
      metrics.increment('cache.hit', { collection: req.call_collection })

      return next()
    }

    debug(`CACHE MISS: ${cacheKey.substring(0, 32)}...`)
    metrics.increment('cache.miss', { collection: req.call_collection })

  } catch (err) {
    // Log but don't fail request on cache errors
    debug(`CACHE ERROR: ${err.message}`)
    metrics.increment('cache.error')
  }

  next()
}

/**
 * Cache PUT middleware - store results after Solr query
 */
module.exports.put = async function (req, res, next) {
  // Skip if disabled, cache hit, or no results
  if (!isEnabled || req.cacheHit || !req.cacheKey || !res.results) {
    return next()
  }

  try {
    const data = JSON.stringify(res.results)

    // Skip caching very large results
    if (data.length > maxCacheSize) {
      debug(`CACHE SKIP (too large): ${data.length} bytes`)
      return next()
    }

    const ttl = ttlStrategy.getTTL(req)

    await client.setex(req.cacheKey, ttl, data)
    debug(`CACHE STORE [TTL=${ttl}s]: ${req.cacheKey.substring(0, 32)}...`)

    // Store tags for invalidation
    if (req.cacheTags && req.cacheTags.length > 0) {
      await storeTagMappings(req.cacheKey, req.cacheTags, ttl)
    }

  } catch (err) {
    debug(`CACHE STORE ERROR: ${err.message}`)
    metrics.increment('cache.store_error')
  }

  next()
}
```

---

## Cache Key Design

### Key Structure

```
p3api:cache:{version}:{user}:{collection}:{method}:{query_hash}
```

**Components:**
- `p3api:cache` - Namespace prefix
- `{version}` - Cache schema version (for invalidation on changes)
- `{user}` - User ID or "public"
- `{collection}` - Solr collection name
- `{method}` - query, get, schema
- `{query_hash}` - MD5 of normalized query parameters

### Key Generator Implementation

```javascript
// valkey-cache/keyGenerator.js
const crypto = require('crypto')
const config = require('../config')

const CACHE_VERSION = 'v1'
const PREFIX = 'p3api:cache'

// Collections with private data (require user isolation)
const privateCollections = new Set([
  'genome', 'genome_sequence', 'genome_feature',
  'pathway', 'sp_gene', 'subsystem',
  'genome_amr', 'genome_typing'
])

module.exports = {
  generate(req) {
    const user = this.getUserKey(req)
    const collection = req.call_collection
    const method = req.call_method
    const queryHash = this.hashQuery(req)

    return `${PREFIX}:${CACHE_VERSION}:${user}:${collection}:${method}:${queryHash}`
  },

  getUserKey(req) {
    // For private collections, include user ID in key
    if (privateCollections.has(req.call_collection)) {
      return req.user?.id || 'public'
    }
    // Public collections share cache across users
    return 'public'
  },

  hashQuery(req) {
    // Normalize query parameters for consistent hashing
    const normalized = {
      params: req.call_params,
      queryType: req.queryType,
      // Include limit/offset for pagination
      limit: req.query?.limit,
      offset: req.query?.offset,
    }

    const str = JSON.stringify(normalized, Object.keys(normalized).sort())
    return crypto.createHash('md5').update(str).digest('hex')
  },

  // Generate tag keys for invalidation
  generateTags(req) {
    const tags = []

    // Collection tag
    tags.push(`tag:collection:${req.call_collection}`)

    // User tag (for private data)
    if (req.user?.id) {
      tags.push(`tag:user:${req.user.id}`)
    }

    // Extract genome_id from query if present (for targeted invalidation)
    const genomeId = this.extractGenomeId(req)
    if (genomeId) {
      tags.push(`tag:genome:${genomeId}`)
    }

    return tags
  },

  extractGenomeId(req) {
    // Parse query for genome_id filter
    const queryStr = req.call_params?.[0] || ''
    const match = queryStr.match(/genome_id[=:]([^\s&)]+)/)
    return match ? match[1] : null
  }
}
```

### Example Cache Keys

```
# Public taxonomy query
p3api:cache:v1:public:taxonomy:query:a1b2c3d4e5f6...

# User's genome query
p3api:cache:v1:user@example.com:genome:query:f6e5d4c3b2a1...

# Schema (shared)
p3api:cache:v1:public:genome_feature:schema:0000000000000000

# Document get by ID
p3api:cache:v1:public:genome:get:md5_of_genome_id
```

---

## TTL Strategy

### Per-Collection TTL Configuration

```javascript
// valkey-cache/ttlStrategy.js
const config = require('../config')

// TTL in seconds
const DEFAULT_TTL = 300  // 5 minutes

const collectionTTL = {
  // Reference data - rarely changes
  taxonomy: 86400,           // 24 hours
  antibiotics: 86400,        // 24 hours
  protein_structure: 43200,  // 12 hours
  epitope: 43200,            // 12 hours
  pathway_ref: 86400,        // 24 hours
  subsystem_ref: 86400,      // 24 hours

  // Public collections - moderate TTL
  genome: 900,               // 15 minutes (public view)
  genome_feature: 900,       // 15 minutes
  surveillance: 3600,        // 1 hour
  serology: 3600,            // 1 hour

  // Active/mutable collections - short TTL
  genome_amr: 300,           // 5 minutes
  genome_typing: 300,        // 5 minutes
  sp_gene: 600,              // 10 minutes
  subsystem: 600,            // 10 minutes
  pathway: 600,              // 10 minutes
}

// Reduction factor for private data
const PRIVATE_TTL_FACTOR = 0.2  // 20% of public TTL

module.exports = {
  getTTL(req) {
    const collection = req.call_collection
    const baseTTL = collectionTTL[collection] || DEFAULT_TTL

    // Reduce TTL for private data (user may modify)
    if (this.isPrivateQuery(req)) {
      return Math.max(60, Math.floor(baseTTL * PRIVATE_TTL_FACTOR))
    }

    // Schema queries get long TTL
    if (req.call_method === 'schema') {
      return 86400  // 24 hours
    }

    // Facet/aggregation queries can be cached longer
    if (this.isFacetQuery(req)) {
      return baseTTL * 2
    }

    return baseTTL
  },

  isPrivateQuery(req) {
    // Check if query includes user-specific filters
    return req.user?.id && !req.publicFree?.includes(req.call_collection)
  },

  isFacetQuery(req) {
    const queryStr = req.call_params?.[0] || ''
    return queryStr.includes('facet=true') || queryStr.includes('json.facet')
  }
}
```

### TTL Summary Table

| Collection | Public TTL | Private TTL | Rationale |
|------------|------------|-------------|-----------|
| taxonomy | 24h | N/A | Reference data, rarely changes |
| antibiotics | 24h | N/A | Reference data |
| protein_structure | 12h | N/A | Semi-static |
| genome | 15min | 3min | Core data, moderate churn |
| genome_feature | 15min | 3min | Related to genome |
| genome_amr | 5min | 1min | Frequently updated |
| genome_typing | 5min | 1min | Frequently updated |
| surveillance | 1h | N/A | Public aggregates |
| schema | 24h | 24h | Only changes on deploy |

---

## Cache Invalidation

### Invalidation Strategies

#### 1. TTL-Based Expiration (Primary)

Most cache entries simply expire based on TTL. This is the simplest and most reliable approach.

#### 2. Tag-Based Invalidation (Targeted)

For mutations (genome updates, permission changes), invalidate affected cache entries:

```javascript
// valkey-cache/invalidation.js
const client = require('./client')
const debug = require('debug')('p3api-server:cache-invalidation')

module.exports = {
  /**
   * Invalidate all cache entries with a specific tag
   */
  async invalidateByTag(tag) {
    const tagKey = `tags:${tag}`
    const cacheKeys = await client.smembers(tagKey)

    if (cacheKeys.length === 0) {
      return 0
    }

    // Delete cache entries and tag set
    const pipeline = client.pipeline()
    cacheKeys.forEach(key => pipeline.del(key))
    pipeline.del(tagKey)

    await pipeline.exec()
    debug(`Invalidated ${cacheKeys.length} entries for tag: ${tag}`)

    return cacheKeys.length
  },

  /**
   * Invalidate cache for a specific genome
   */
  async invalidateGenome(genomeId) {
    return this.invalidateByTag(`genome:${genomeId}`)
  },

  /**
   * Invalidate all cache for a user (e.g., on permission change)
   */
  async invalidateUser(userId) {
    return this.invalidateByTag(`user:${userId}`)
  },

  /**
   * Invalidate entire collection cache
   */
  async invalidateCollection(collection) {
    const pattern = `p3api:cache:*:${collection}:*`
    return this.invalidateByPattern(pattern)
  },

  /**
   * Invalidate by key pattern (use sparingly - SCAN is expensive)
   */
  async invalidateByPattern(pattern) {
    let cursor = '0'
    let totalDeleted = 0

    do {
      const [newCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor

      if (keys.length > 0) {
        await client.del(...keys)
        totalDeleted += keys.length
      }
    } while (cursor !== '0')

    debug(`Pattern invalidation deleted ${totalDeleted} keys: ${pattern}`)
    return totalDeleted
  },

  /**
   * Purge entire cache (admin operation)
   */
  async purgeAll() {
    const pattern = 'p3api:cache:*'
    return this.invalidateByPattern(pattern)
  }
}
```

#### 3. Hook Integration

Integrate with genome permission router for automatic invalidation:

```javascript
// Integration point in routes/genomePermissionRouter.js

const invalidation = require('../valkey-cache/invalidation')

// After permission change
router.post('/permissions', async (req, res, next) => {
  // ... existing permission logic ...

  // Invalidate affected caches
  const { genome_id, user } = req.body

  await Promise.all([
    invalidation.invalidateGenome(genome_id),
    invalidation.invalidateUser(user)
  ])

  next()
})
```

### Invalidation Admin API

```javascript
// routes/cacheAdmin.js (new file)
const express = require('express')
const router = express.Router()
const invalidation = require('../valkey-cache/invalidation')
const authMiddleware = require('../middleware/auth')

// Require admin authentication
router.use(authMiddleware)
router.use((req, res, next) => {
  if (!req.user?.roles?.includes('admin')) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
})

// Purge cache for a collection
router.delete('/cache/collection/:collection', async (req, res) => {
  const count = await invalidation.invalidateCollection(req.params.collection)
  res.json({ deleted: count, collection: req.params.collection })
})

// Purge cache for a genome
router.delete('/cache/genome/:genome_id', async (req, res) => {
  const count = await invalidation.invalidateGenome(req.params.genome_id)
  res.json({ deleted: count, genome_id: req.params.genome_id })
})

// Purge entire cache (dangerous!)
router.delete('/cache/all', async (req, res) => {
  const count = await invalidation.purgeAll()
  res.json({ deleted: count, warning: 'Full cache purge completed' })
})

// Get cache stats
router.get('/cache/stats', async (req, res) => {
  const stats = await require('../valkey-cache/metrics').getStats()
  res.json(stats)
})

module.exports = router
```

---

## Configuration

### Updated p3api.conf Structure

```json
{
  "production": true,
  "solr": {
    "url": "http://localhost:8983/solr"
  },
  "redis": {
    "host": "127.0.0.1",
    "port": 6379,
    "db": 2
  },
  "valkey": {
    "enable": true,
    "host": "127.0.0.1",
    "port": 6379,
    "db": 1,
    "password": null,
    "maxResultSize": 10485760,
    "defaultTTL": 300,
    "connectionTimeout": 5000,
    "cluster": {
      "enable": false,
      "nodes": []
    },
    "metrics": {
      "enable": true,
      "endpoint": "/metrics/cache"
    }
  },
  "cache": {
    "enable": false,
    "directory": "/cache"
  }
}
```

### Environment Variable Overrides

```bash
# Production configuration via environment
export VALKEY_HOST=valkey.internal.example.com
export VALKEY_PORT=6379
export VALKEY_PASSWORD=secret_password
export VALKEY_DB=1
export VALKEY_ENABLE=true
export VALKEY_MAX_RESULT_SIZE=10485760
```

### Config Module Updates

```javascript
// config.js additions
module.exports = {
  // ... existing config ...

  valkey: {
    enable: process.env.VALKEY_ENABLE === 'true' || false,
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT, 10) || 6379,
    db: parseInt(process.env.VALKEY_DB, 10) || 1,
    password: process.env.VALKEY_PASSWORD || null,
    maxResultSize: parseInt(process.env.VALKEY_MAX_RESULT_SIZE, 10) || 10 * 1024 * 1024,
    defaultTTL: parseInt(process.env.VALKEY_DEFAULT_TTL, 10) || 300,
  }
}
```

---

## Monitoring & Metrics

### Metrics Collection

```javascript
// valkey-cache/metrics.js
const client = require('./client')
const debug = require('debug')('p3api-server:cache-metrics')

// In-memory counters (reset on restart)
const counters = {
  hits: 0,
  misses: 0,
  errors: 0,
  storeErrors: 0,
  bypassed: 0,
}

const collectionStats = new Map()

module.exports = {
  increment(metric, tags = {}) {
    counters[metric.replace('cache.', '')]++

    // Track per-collection stats
    if (tags.collection) {
      const collStats = collectionStats.get(tags.collection) || { hits: 0, misses: 0 }
      if (metric === 'cache.hit') collStats.hits++
      if (metric === 'cache.miss') collStats.misses++
      collectionStats.set(tags.collection, collStats)
    }
  },

  async getStats() {
    const info = await client.info('memory')
    const dbSize = await client.dbsize()

    const hitRate = counters.hits + counters.misses > 0
      ? (counters.hits / (counters.hits + counters.misses) * 100).toFixed(2)
      : 0

    return {
      cache: {
        hits: counters.hits,
        misses: counters.misses,
        hitRate: `${hitRate}%`,
        errors: counters.errors,
        storeErrors: counters.storeErrors,
        bypassed: counters.bypassed,
      },
      valkey: {
        connected: client.status === 'ready',
        keyCount: dbSize,
        memoryUsage: this.parseMemoryInfo(info),
      },
      byCollection: Object.fromEntries(collectionStats),
    }
  },

  parseMemoryInfo(info) {
    const match = info.match(/used_memory_human:(\S+)/)
    return match ? match[1] : 'unknown'
  },

  // Prometheus-compatible metrics endpoint
  async getPrometheusMetrics() {
    const stats = await this.getStats()
    return `
# HELP p3api_cache_hits_total Total cache hits
# TYPE p3api_cache_hits_total counter
p3api_cache_hits_total ${stats.cache.hits}

# HELP p3api_cache_misses_total Total cache misses
# TYPE p3api_cache_misses_total counter
p3api_cache_misses_total ${stats.cache.misses}

# HELP p3api_cache_hit_rate Cache hit rate percentage
# TYPE p3api_cache_hit_rate gauge
p3api_cache_hit_rate ${parseFloat(stats.cache.hitRate)}

# HELP p3api_cache_keys_total Total keys in cache
# TYPE p3api_cache_keys_total gauge
p3api_cache_keys_total ${stats.valkey.keyCount}

# HELP p3api_cache_errors_total Total cache errors
# TYPE p3api_cache_errors_total counter
p3api_cache_errors_total ${stats.cache.errors}
`.trim()
  }
}
```

### Health Check Integration

```javascript
// Add to existing /health endpoint or create /health/cache

router.get('/health/cache', async (req, res) => {
  try {
    const start = Date.now()
    await client.ping()
    const latency = Date.now() - start

    const stats = await metrics.getStats()

    res.json({
      status: 'healthy',
      latency: `${latency}ms`,
      ...stats
    })
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message
    })
  }
})
```

### Grafana Dashboard Queries (Example)

```
# Cache hit rate over time
rate(p3api_cache_hits_total[5m]) /
(rate(p3api_cache_hits_total[5m]) + rate(p3api_cache_misses_total[5m])) * 100

# Cache operations per second
rate(p3api_cache_hits_total[1m]) + rate(p3api_cache_misses_total[1m])

# Error rate
rate(p3api_cache_errors_total[5m])
```

---

## Migration Path

### Step 1: Parallel Operation

Run both file-based cache (if enabled) and Valkey cache simultaneously:

```javascript
// Transitional middleware
module.exports.get = async function (req, res, next) {
  // Try Valkey first
  const valkeyResult = await tryValkey(req)
  if (valkeyResult) {
    return handleCacheHit(req, res, valkeyResult, next)
  }

  // Fall back to file cache (if still enabled)
  const fileResult = await tryFileCache(req)
  if (fileResult) {
    // Migrate to Valkey
    await storeInValkey(req, fileResult)
    return handleCacheHit(req, res, fileResult, next)
  }

  next()
}
```

### Step 2: Deprecate File Cache

After validation period (1-2 weeks):

1. Set `cache.enable: false` in config
2. Remove file cache middleware from chain
3. Remove `cache.js` and `middleware/cache.js`

### Step 3: Consolidate Redis Usage

Consider migrating apicache to use same Valkey instance:

```javascript
// routes/dataRouter.js
const valkeyClient = require('../valkey-cache/client')
const cacheWithValkey = apicache.options({
  redisClient: valkeyClient
}).middleware
```

---

## Risk Assessment

### Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Cache poisoning (stale data served) | Medium | High | Conservative TTLs, invalidation hooks |
| Valkey outage | Low | Medium | Graceful degradation, fallback to Solr |
| Memory exhaustion | Medium | Medium | maxmemory policy, result size limits |
| Cache stampede | Low | High | Consider locking/coalescing for hot keys |
| Private data leakage | Low | Critical | User isolation in cache keys, code review |

### Graceful Degradation

```javascript
// Always fall back to Solr on cache errors
module.exports.get = async function (req, res, next) {
  try {
    // ... cache logic ...
  } catch (err) {
    debug(`Cache error, falling back to Solr: ${err.message}`)
    // Don't set cacheKey, so PUT will be skipped too
    next()
  }
}
```

### Security Considerations

1. **User Isolation**: Private collection cache keys MUST include user ID
2. **No Sensitive Data in Keys**: Keys are visible in Valkey; use hashes
3. **TTL Limits**: Enforce maximum TTL to prevent indefinite caching
4. **Admin API Authentication**: Require admin role for cache management

---

## Appendix: File Structure

```
p3_api/
├── valkey-cache/                 # NEW: Valkey caching module
│   ├── index.js                  # Module exports
│   ├── client.js                 # Valkey connection
│   ├── middleware.js             # GET/PUT middleware
│   ├── keyGenerator.js           # Cache key generation
│   ├── ttlStrategy.js            # TTL configuration
│   ├── invalidation.js           # Cache invalidation
│   └── metrics.js                # Monitoring/metrics
├── routes/
│   ├── dataType.js               # MODIFIED: Add cache middleware
│   ├── dataRouter.js             # EXISTING: Keep apicache
│   └── cacheAdmin.js             # NEW: Admin cache API
├── middleware/
│   ├── cache.js                  # DEPRECATED: File-based cache
│   └── ...
├── cache.js                      # DEPRECATED: File storage
├── config.js                     # MODIFIED: Add valkey config
└── p3api.conf                    # MODIFIED: Add valkey section
```

---

## Appendix: Quick Reference

### Enable Caching (Production)

```json
{
  "valkey": {
    "enable": true,
    "host": "valkey.internal",
    "port": 6379,
    "password": "secure_password"
  }
}
```

### Disable Caching (Development)

```json
{
  "valkey": {
    "enable": false
  }
}
```

### Manual Cache Purge

```bash
# Purge specific genome
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/admin/cache/genome/562.1

# Purge collection
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/admin/cache/collection/genome

# Full purge
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/admin/cache/all
```

### Check Cache Stats

```bash
curl http://localhost:3001/health/cache
```

---

*End of Document*
