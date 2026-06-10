# Cross-Collection Faceting for Joined Fields

## Context

The join enrichment feature (already implemented) allows paginated queries to include fields from related collections (e.g., `strain`, `genome_status` from `genome` when querying `genome_feature`). Users now want to **facet** on these joined fields.

**Problem:** Solr faceting happens during query execution on fields that exist in the queried collection. Fields like `strain` and `genome_status` don't exist in `genome_feature` - they're in `genome`. Standard Solr faceting cannot facet on fields from a different collection.

**Solution:** Implement cross-collection faceting as a post-query operation:
1. Detect when user requests a facet on a joinable field
2. Extract unique join key values from the query results
3. Execute a facet query against the target collection (e.g., `genome`)
4. Merge facet results back into the response

## Design Decisions

- **Trigger:** Facet-aware - cross-collection faceting only performed when client requests facets on joinable fields via `facet((field,X))` RQL or `facet.field=X` Solr parameter
- **Scope:** Full result set - facets are computed across ALL matching documents, not just the current page (accurate facet counts)
- **Reuse:** Leverages existing `joinEnrichment` configuration for field mappings
- **Output:** Standard Solr `facet_counts.facet_fields` format

## Implementation Plan

### Phase 1: Extend parseFieldList.js

**File:** `lib/parseFieldList.js`

Add functions to detect facet fields from Solr query string:

```javascript
/**
 * Extract facet field names from Solr query string.
 * Handles: facet.field=genome_name and multiple facet.field parameters
 *
 * @param {string} query - Solr query string
 * @returns {Array<string>} Array of facet field names
 */
function parseFacetFields(query) {
  if (!query || typeof query !== 'string') return []

  // Match all facet.field= parameters
  const matches = query.match(/(?:^|[&?])facet\.field=([^&]*)/g)
  if (!matches) return []

  return matches.map(match => {
    const value = match.split('=')[1]
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim()
  })
}

/**
 * Get facet fields that require cross-collection queries.
 *
 * @param {string} query - Solr query string
 * @param {Object} joinableFields - Collection's joinable field configuration
 * @returns {Array<string>} Facet fields that are joinable
 */
function getCrossCollectionFacets(query, joinableFields) {
  if (!joinableFields) return []

  const facetFields = parseFacetFields(query)
  const joinableFieldNames = Object.keys(joinableFields)

  return facetFields.filter(field => joinableFieldNames.includes(field))
}
```

### Phase 2: Create CrossCollectionFaceting Middleware

**File:** `middleware/CrossCollectionFaceting.js`

New middleware that executes cross-collection facet queries:

```javascript
const debug = require('debug')('p3api-server:middleware/CrossCollectionFaceting')
const Config = require('../config')
const { getCrossCollectionFacets } = require('../lib/parseFieldList')

// Singleton DirectSolrClient (lazy initialized, similar to JoinEnrichment)
let directClient = null

async function crossCollectionFacetingMiddleware(req, res, next) {
  // Only process query method
  if (req.call_method !== 'query') return next()

  // Need docs to extract join keys from
  if (!res.results?.response?.docs?.length) return next()

  const config = getJoinConfig()  // Reuse from JoinEnrichment
  if (!config.enabled) return next()

  const collectionConfig = config.collections[req.call_collection]
  if (!collectionConfig?.joinableFields) return next()

  // Detect cross-collection facet requests
  const query = req.call_params[0] || ''
  const crossCollectionFacets = getCrossCollectionFacets(query, collectionConfig.joinableFields)

  if (crossCollectionFacets.length === 0) return next()

  debug(`Cross-collection facets requested: ${crossCollectionFacets.join(', ')}`)

  try {
    // Group facets by target collection and join key
    const facetSpecs = buildFacetSpecs(crossCollectionFacets, collectionConfig.joinableFields)

    // Execute cross-collection facet queries
    const client = await getDirectClient()
    const facetResults = await executeCrossCollectionFacets(
      res.results.response.docs,
      facetSpecs,
      client
    )

    // Merge into response
    if (!res.results.facet_counts) {
      res.results.facet_counts = { facet_fields: {} }
    }
    if (!res.results.facet_counts.facet_fields) {
      res.results.facet_counts.facet_fields = {}
    }
    Object.assign(res.results.facet_counts.facet_fields, facetResults)

    // Set header to indicate cross-collection faceting was performed
    res.set('X-CrossCollection-Facets', crossCollectionFacets.join(','))

    next()
  } catch (err) {
    console.error(`CrossCollectionFaceting error: ${err.message}`)
    debug(`Error: ${err.stack}`)
    // Don't fail the request, just skip faceting
    next()
  }
}

/**
 * Build facet specifications grouped by target collection.
 */
function buildFacetSpecs(facetFields, joinableFields) {
  const specs = new Map()  // key: "collection:joinKey" -> { collection, joinKey, fields: [] }

  for (const fieldName of facetFields) {
    const config = joinableFields[fieldName]
    if (!config) continue

    const key = `${config.from}:${config.via}`
    if (!specs.has(key)) {
      specs.set(key, {
        targetCollection: config.from,
        joinKeyField: config.via,
        facetFields: []
      })
    }
    specs.get(key).facetFields.push(config.field)
  }

  return Array.from(specs.values())
}

/**
 * Execute cross-collection facet queries with full result set support.
 */
async function executeCrossCollectionFacets(req, res, facetSpecs, client) {
  const results = {}
  const query = req.call_params[0] || ''

  for (const spec of facetSpecs) {
    // Step 1: Get ALL join keys from the full result set
    // Re-execute the query with rows=unlimited, fl=joinKeyField only
    const joinKeys = await fetchAllJoinKeys(req, spec.joinKeyField, client)

    if (joinKeys.length === 0) continue

    debug(`Fetching facets from ${spec.targetCollection} for ${joinKeys.length} unique keys`)

    // Step 2: Execute facet query on target collection with all keys
    // For large key sets, may need to batch or use streaming
    const response = await client.query(spec.targetCollection, {
      q: '*:*',
      fq: `{!terms f=${spec.joinKeyField}}${joinKeys.join(',')}`,
      rows: 0,
      facet: true,
      'facet.field': spec.facetFields,
      'facet.mincount': 1,
      'facet.limit': -1  // Get all facet values
    })

    // Extract and merge facet results
    if (response.facet_counts?.facet_fields) {
      for (const field of spec.facetFields) {
        if (response.facet_counts.facet_fields[field]) {
          results[field] = response.facet_counts.facet_fields[field]
        }
      }
    }
  }

  return results
}

/**
 * Fetch all join keys from the full result set.
 * Re-executes the query requesting only the join key field.
 */
async function fetchAllJoinKeys(req, joinKeyField, client) {
  // Build query to get all join keys
  // Strip pagination (rows, start) and field list (fl) from original query
  // Request only the join key field

  const originalQuery = req.call_params[0] || ''
  const strippedQuery = stripPaginationParams(originalQuery)

  // First, get the count
  const countResponse = await client.query(req.call_collection, {
    ...parseQueryParams(strippedQuery),
    rows: 0,
    fl: joinKeyField
  })

  const numFound = countResponse.response?.numFound || 0

  if (numFound === 0) return []

  // Configurable limit to prevent memory issues
  const maxKeysForFaceting = 100000
  const keysToFetch = Math.min(numFound, maxKeysForFaceting)

  if (numFound > maxKeysForFaceting) {
    debug(`Warning: Result set (${numFound}) exceeds max for cross-collection faceting (${maxKeysForFaceting})`)
  }

  // Fetch all keys (or up to limit)
  const keysResponse = await client.query(req.call_collection, {
    ...parseQueryParams(strippedQuery),
    rows: keysToFetch,
    fl: joinKeyField,
    sort: `${joinKeyField} asc`  // Consistent ordering
  })

  // Extract unique keys
  const keys = new Set()
  for (const doc of keysResponse.response?.docs || []) {
    if (doc[joinKeyField]) {
      keys.add(doc[joinKeyField])
    }
  }

  return Array.from(keys)
}
```

### Phase 3: Extend JoinFieldInjector for Facets

**File:** `middleware/JoinFieldInjector.js`

Extend to also inject join keys when cross-collection facets are requested:

```javascript
// Add import
const { getCrossCollectionFacets } = require('../lib/parseFieldList')

// In joinFieldInjectorMiddleware, after detecting select join fields:

// Existing: detect requested join fields for select
const requestedJoinFields = getRequestedJoinFields(query, collectionConfig.joinableFields)

// NEW: also detect cross-collection facets
const crossCollectionFacets = getCrossCollectionFacets(query, collectionConfig.joinableFields)

// Combine both for key injection
const allJoinFields = [...new Set([...requestedJoinFields, ...crossCollectionFacets])]

if (allJoinFields.length === 0) return next()

// Rest of the function uses allJoinFields instead of requestedJoinFields
```

### Phase 4: Update DirectSolrClient for Facet Queries

**File:** `lib/distributed/DirectSolrClient.js`

The existing `query()` method should work, but needs to handle facet parameters properly:

```javascript
// In the query() method, add facet parameter handling:

if (params.facet) {
  queryParams.set('facet', 'true')
}

if (params['facet.field']) {
  const fields = Array.isArray(params['facet.field'])
    ? params['facet.field']
    : [params['facet.field']]
  fields.forEach(f => queryParams.append('facet.field', f))
}

if (params['facet.mincount']) {
  queryParams.set('facet.mincount', String(params['facet.mincount']))
}
```

### Phase 5: Register Middleware

**File:** `routes/dataType.js`

Add CrossCollectionFaceting middleware to the chain:

```javascript
const CrossCollectionFaceting = require('../middleware/CrossCollectionFaceting')

router.use([
  RQLQueryParser,
  DecorateQuery,
  Limiter,
  JoinFieldInjector,       // Injects join keys for both select AND facet
  DistributedQuery,
  ShardsPreference,
  // ...
  APIMethodHandler,
  reqCounter,
  ExtractCustomFields,
  ContentRange,
  CrossCollectionFaceting, // ← NEW: Execute cross-collection facets
  JoinEnrichment,          // Existing: Enrich doc fields
  media
])
```

### Phase 6: Testing

**File:** `tests/test-join/test.crosscollectionfacet.spec.js`

```javascript
describe('CrossCollectionFaceting', function() {
  describe('parseFacetFields', function() {
    it('should extract facet.field parameters')
    it('should handle multiple facet.field parameters')
    it('should handle URL-encoded values')
  })

  describe('getCrossCollectionFacets', function() {
    it('should identify joinable facet fields')
    it('should return empty for non-joinable fields')
  })

  describe('Middleware', function() {
    it('should skip when no cross-collection facets requested')
    it('should execute facet query on target collection')
    it('should merge facet results into response')
    it('should handle errors gracefully')
  })
})
```

## Files to Create

| File | Purpose |
|------|---------|
| `middleware/CrossCollectionFaceting.js` | Main middleware for cross-collection facet execution |
| `tests/test-join/test.crosscollectionfacet.spec.js` | Unit and integration tests |

## Files to Modify

| File | Changes |
|------|---------|
| `lib/parseFieldList.js` | Add `parseFacetFields()` and `getCrossCollectionFacets()` |
| `middleware/JoinFieldInjector.js` | Extend to detect facet fields for key injection |
| `lib/distributed/DirectSolrClient.js` | Add facet parameter handling to `query()` method |
| `routes/dataType.js` | Register CrossCollectionFaceting middleware |

## Query Flow Example

**User RQL query:**
```
/genome_feature/?eq(genome_id,83332.12)&facet((field,strain),(field,genome_status),(mincount,1))&limit(100)
```

**Converted to Solr by RQLQueryParser:**
```
q=genome_id:83332.12&rows=100&facet=true&facet.field=strain&facet.field=genome_status&facet.mincount=1
```

**Processing flow:**
1. `JoinFieldInjector` detects `strain` and `genome_status` as joinable facets → injects `genome_id` into `fl=`
2. `APIMethodHandler` executes query → returns docs with `genome_id` field (facet_counts empty for non-existent fields)
3. `CrossCollectionFaceting` middleware:
   - Extracts unique `genome_id` values from docs: `[83332.12]`
   - Executes against `genome` collection:
     ```
     q=*:*&fq={!terms f=genome_id}83332.12&rows=0&facet=true&facet.field=strain&facet.field=genome_status&facet.mincount=1
     ```
   - Merges `facet_counts.facet_fields` into response
4. `JoinEnrichment` enriches doc fields (if requested in select)
5. Response includes proper facet counts

**Response:**
```json
{
  "response": {
    "numFound": 4203,
    "docs": [...]
  },
  "facet_counts": {
    "facet_fields": {
      "strain": ["H37Rv", 100],
      "genome_status": ["Complete", 100]
    }
  }
}
```

## Important Limitation

**Full result set faceting:** Cross-collection facets are computed across ALL matching documents in the result set, not just the current page. This ensures facet counts accurately represent the full query results.

**Implementation approach for full result set:**
1. Execute initial query with `rows=0` to get `numFound` and extract the main query filters
2. Execute a second query with `rows=numFound` requesting only the join key field (e.g., `fl=genome_id`)
3. Use the complete set of join keys for the cross-collection facet query
4. This adds latency but provides accurate facet counts

**Performance note:** For queries matching millions of documents, this could be slow. Consider adding a configurable limit (e.g., max 100,000 IDs for faceting) with a warning header if exceeded.

## Verification

**Manual testing:**
```bash
# Start server with debug
DEBUG=p3api-server:middleware/CrossCollectionFaceting npm start

# Test cross-collection facet
curl 'http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&facet((field,strain),(mincount,1))&limit(10)' \
  -H 'Accept: application/solr+json'

# Verify facet_counts in response includes strain facet
```

**Automated tests:**
```bash
npx mocha tests/test-join/test.crosscollectionfacet.spec.js
npx mocha tests/test-join/  # Run all join tests
```
