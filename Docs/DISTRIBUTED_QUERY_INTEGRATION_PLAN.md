# Distributed Query Integration Plan for BV-BRC API

## Context

The distributed query system (`lib/distributed/`) has been built and tested, achieving significant performance improvements:
- **maxParallelism=70**: 38.7s for 1M docs (best)
- **Default maxParallelism=8**: 175s for 1M docs
- **4.5x speedup** for large result sets

This plan integrates distributed queries into the main `/:dataType/` API endpoints while maintaining backward compatibility and all security controls.

## Architecture Overview

```
Current Flow:
  RQLQueryParser → DecorateQuery → Limiter → ShardsPreference → APIMethodHandler → media

New Flow (distributed path):
  RQLQueryParser → DecorateQuery → Limiter → [DistributedQuery] → media
                                                    ↓
                                            (skips APIMethodHandler)
                                                    ↓
                                            DistributedQueryManager
```

**Key Integration Point**: After `DecorateQuery` (permission filters applied) and `Limiter` (limits enforced), but before `APIMethodHandler`.

## Implementation Steps

### Step 1: Create Distributed Query Middleware

**New File: `middleware/DistributedQuery.js`**

Middleware that:
1. Decides whether to use distributed query based on:
   - Collection whitelist/blacklist
   - Request limit threshold (default: 10000+)
   - Call method (query/stream, not get)
   - Header override: `X-Distributed-Query: true/false`
   - Query param override: `?distributed=true/false`
2. Extracts the Solr query from `req.call_params[0]` (already includes permission filters)
3. Executes via `DistributedQueryManager.executeQuery()`
4. Wraps the stream for media handler compatibility
5. Sets `res.results` and skips to media handlers
6. Falls back to standard query on error

### Step 2: Modify APIMethodHandler to Support Skip

**File: `middleware/APIMethodHandler.js`**

Add at the start of each handler method:
```javascript
if (req.skipAPIMethodHandler && res.results) {
  return next();
}
```

### Step 3: Update Route Chain

**File: `routes/dataType.js`**

Insert middleware after `Limiter`, before `ShardsPreference`:
```javascript
const DistributedQuery = require('../middleware/DistributedQuery');

// In middleware chain:
[
  ...,
  DecorateQuery,
  Limiter,
  DistributedQuery,  // <-- NEW
  ShardsPreference,
  APIMethodHandler,
  ...
]
```

### Step 4: Configuration Updates

**File: `p3api.conf`**

Add configuration section:
```json
{
  "distributedQuery": {
    "enabled": true,
    "maxParallelism": 70,
    "minLimitThreshold": 10000,
    "enabledCollections": [
      "genome_feature",
      "genome_sequence",
      "feature_sequence"
    ],
    "exposeMetadataHeaders": true
  }
}
```

### Step 5: Update DistributedQueryConfig

**File: `lib/distributed/DistributedQueryConfig.js`**

Add new config options:
- `minLimitThreshold` - Minimum row limit to trigger distributed query
- `enabledCollections` - Collections that can use distributed queries
- `disabledCollections` - Collections explicitly disabled
- `exposeMetadataHeaders` - Whether to add X-Distributed-* headers

## Key Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `middleware/DistributedQuery.js` | CREATE | Main integration middleware |
| `middleware/APIMethodHandler.js` | MODIFY | Add skip logic |
| `routes/dataType.js` | MODIFY | Add middleware to chain |
| `lib/distributed/DistributedQueryConfig.js` | MODIFY | Add new config options |

## Existing Code to Reuse

- `lib/distributed/DistributedQueryManager.js` - Already built, use `executeQuery()`
- `lib/distributed/utils.js` - `prewarmShards()` for pre-query warm-up
- `lib/distributed/MergeSortStream.js` - For sorted output
- `lib/distributed/ParallelQueryCoordinator.js` - For unordered output

## Response Headers (when distributed query used)

```
X-Distributed-Query: true
X-Total-Found: 682179670
X-Parallelism: 70
X-Prewarm-Time-Ms: 1614
X-Stream-Type: parallel|merge-sort
```

## Security Considerations

1. **Permission filters preserved**: DecorateQuery runs BEFORE distributed query
2. **Authentication preserved**: Auth middleware runs before entire chain
3. **Public/private collections**: Same logic applies (publicFree list checked)
4. **No query injection risk**: Using pre-processed Solr query from middleware chain

## Fallback Strategy

1. **On error**: Fall back to standard APIMethodHandler
2. **Circuit breaker**: After N consecutive failures, disable distributed queries temporarily
3. **Per-request override**: `X-Distributed-Query: false` forces standard path
4. **Global disable**: Set `distributedQuery.enabled: false` in config

## Testing Approach

1. **Unit tests**: Test decision logic (when to use distributed query)
2. **Integration tests**: Test with various collections and media types
3. **Performance tests**: Verify speedup for large result sets
4. **Permission tests**: Verify private data access control works

```bash
# Run existing distributed tests
npm run test-distributed

# Test integration with main API
curl -H "X-Distributed-Query: true" \
  "http://localhost:3001/genome_feature/?limit(100000)"
```

## Rollout Strategy

1. **Phase 1**: Enable for `genome_feature` only with minLimit=50000
2. **Phase 2**: Lower threshold to 10000, add more collections
3. **Phase 3**: Enable by default for all sharded collections

## Configuration Recommendations

Based on performance testing:

```json
{
  "distributedQuery": {
    "enabled": true,
    "maxParallelism": 70,
    "prewarmShards": true,
    "minLimitThreshold": 10000,
    "enabledCollections": ["genome_feature"]
  }
}
```
