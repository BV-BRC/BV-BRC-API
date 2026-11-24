# Genome Post-Filter for Negation-Only Conditions

## Context

Queries like `genome_feature/?keyword(brucella)&genome(ne(genome_status,Deprecated))` fail because the `genome()` RQL operator generates a Solr cross-collection join with a pure negation (`!genome_status:Deprecated`), which returns zero results in Solr. Adding `*:*` to fix correctness makes the query very slow because Solr must stream nearly every genome_id through the join.

**Solution:** For negation-only genome conditions, skip the Solr join and instead run the main query first (which is fast/selective), then fetch genome metadata for the matching results and filter in JavaScript. This is what a relational query optimizer would do.

## How the Current Cross-Collection Join Works

1. Solr sends the query (e.g., `!genome_status:Deprecated`) to the `genome` collection
2. Matching genome_ids are streamed back
3. A bitset is built in the local `genome_feature` index for matching features
4. The bitset is cached and used as a filter

For pure negations, step 1 must match nearly every genome (everything except deprecated), making it very slow.

## Proposed Approach

1. Detect negation-only genome conditions during RQL parsing
2. Run the main query without the genome join (e.g., `keyword(brucella)` narrows results dramatically)
3. Fetch genome metadata for the small set of matching genome_ids
4. Filter results in JavaScript based on the negation conditions
5. Apply pagination (trim to requested page window)

## Files to Modify

| File | Change |
|------|--------|
| `solrjs.fixed/rql.js` | Add `toSolrWithMeta()` method, `isNegationOnly()` helper, `extractFieldsFromConditions()` helper |
| `middleware/RQLQueryParser.js` | Call `toSolrWithMeta()`, stash deferred conditions on `req`, over-fetch, inject genome_id into fl= |
| `middleware/GenomePostFilter.js` | **New** - post-query middleware that applies deferred genome filters |
| `routes/dataType.js` | Register GenomePostFilter after ExtractCustomFields, before ContentRange |

## Implementation Details

### 1. `solrjs.fixed/rql.js` - Add `toSolrWithMeta()` method

Add two helpers and a new method that wraps the existing `toSolr()` logic:

- **`isNegationOnly(genomeArgs)`** - returns `true` if all genome args (excluding `to()`) have `name === 'ne'`
- **`extractFieldsFromConditions(conditions)`** - collects field names referenced in conditions (e.g., `genome_status` from `ne(genome_status, Deprecated)`)
- **`toSolrWithMeta(opts)`** - same as `toSolr()` but when genome conditions are negation-only, omits the `fq` join and returns `{ solrQuery, genomePostFilter: { conditions, joinToColumnName, fieldsNeeded } }`. When conditions are NOT negation-only, returns `{ solrQuery, genomePostFilter: null }`.

`toSolr()` remains unchanged for backward compatibility.

#### `isNegationOnly()` logic

A genome condition list is negation-only when every arg (excluding `to()`) has `name === 'ne'`. If any positive operator appears (`eq`, `in`, `gt`, `lt`, `between`, etc.), the join remains fast and correct - leave it alone.

```javascript
function isNegationOnly(genomeArgs) {
  for (const arg of genomeArgs) {
    if (arg.name === 'to') continue
    if (arg.name !== 'ne') return false
  }
  return true
}
```

#### Modified genome block in `toSolrWithMeta()` (currently lines 75-92)

```javascript
if (normalized.genome && normalized.genome.length > 0) {
  var joinToColumnName = 'genome_id'
  var parts = []
  var conditions = []

  normalized.genome.forEach((a) => {
    switch (a.name) {
      case 'to':
        joinToColumnName = a.args[0]
        break
      default:
        parts.push(queryToSolr(a, {}))
        conditions.push(a)
        break
    }
  })

  if (meta && isNegationOnly(normalized.genome)) {
    // Defer to post-filter - do NOT emit fq join
    meta.genomePostFilter = {
      conditions: conditions,
      joinToColumnName: joinToColumnName,
      fieldsNeeded: extractFieldsFromConditions(conditions)
    }
  } else {
    // Normal path: emit cross-collection join
    var joinQuery = `&fq={!join method=crossCollection fromIndex=genome from=genome_id to=${joinToColumnName}}` +
      (parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`)
    sq += joinQuery
  }
}
```

### 2. `middleware/RQLQueryParser.js` - Use `toSolrWithMeta()`

At line 105-107, change from `rq.toSolr()` to `rq.toSolrWithMeta()`. When `genomePostFilter` is returned and `!req.isDownload` and `!req.cursorMark`:

- Store on `req.genomePostFilter`
- Parse `rows` and `start` from the Solr query string
- Over-fetch: set `rows = (start + rows) * 3`, `start = 0`
- Store `originalRows` and `originalStart` for later trimming
- Inject `genome_id` (or `joinToColumnName`) into `fl=` if `fl=` is present and doesn't already include it

When `req.isDownload` or `req.cursorMark`, don't activate the post-filter - fall back to the existing join behavior (use `rq.toSolr()` in those cases).

```javascript
const rq = Rql(q)
const max = (req.isDownload) ? 999999999 : 25000
const result = rq.toSolrWithMeta({ maxRequestLimit: max, defaultLimit: 25 })
req.call_params[0] = result.solrQuery

if (result.genomePostFilter && !req.isDownload && !req.cursorMark) {
  req.genomePostFilter = result.genomePostFilter

  // Parse current rows and start
  const rowsMatch = result.solrQuery.match(/&rows=(\d+)/)
  const startMatch = result.solrQuery.match(/&start=(\d+)/)
  const originalRows = rowsMatch ? parseInt(rowsMatch[1], 10) : 25
  const originalStart = startMatch ? parseInt(startMatch[1], 10) : 0

  req.genomePostFilter.originalRows = originalRows
  req.genomePostFilter.originalStart = originalStart

  // Over-fetch from offset 0 to have enough after filtering
  const OVERFETCH_MULTIPLIER = 3
  const overFetchRows = (originalStart + originalRows) * OVERFETCH_MULTIPLIER
  let solrQuery = req.call_params[0]
  solrQuery = solrQuery.replace(/&rows=\d+/, '&rows=' + overFetchRows)
  if (startMatch) {
    solrQuery = solrQuery.replace(/&start=\d+/, '&start=0')
  }
  req.call_params[0] = solrQuery

  // Inject genome_id into fl= if needed
  const joinCol = result.genomePostFilter.joinToColumnName
  const flMatch = req.call_params[0].match(/([&?]fl=)([^&]*)/)
  if (flMatch) {
    const flValue = decodeURIComponent(flMatch[2])
    if (flValue !== '*' && flValue !== '' && !flValue.split(',').map(f => f.trim()).includes(joinCol)) {
      req.call_params[0] = req.call_params[0].replace(
        /([&?]fl=)([^&]*)/,
        '$1' + '$2' + ',' + joinCol
      )
      req.genomePostFilter.injectedJoinCol = true
    }
  }
}
```

### 3. `middleware/GenomePostFilter.js` - New post-query middleware

Runs after ExtractCustomFields, before ContentRange.

**Logic:**
1. Skip if `!req.genomePostFilter` or `req.call_method !== 'query'` or no docs
2. Collect unique genome_id values from results
3. Use `getJoiner()` from JoinEnrichment to access `joiner.solrClient.fetchByIdsAsDict()` to fetch genome docs with only the needed fields
4. Build a JS predicate from conditions: `ne(field, val)` becomes `doc[field] !== val`, all conditions AND'd
5. Filter docs, keeping only those whose genome passes the predicate
6. Slice to `[originalStart, originalStart + originalRows]`
7. Estimate `numFound` by scaling original numFound by observed pass rate
8. Set `res.results.response.start = originalStart`
9. Clean up injected genome_id from docs if it was injected
10. Set observability headers: `X-Genome-PostFilter`, `X-Genome-PostFilter-Removed`, `X-Genome-PostFilter-Time-Ms`
11. On error: fail open - return unfiltered results with proper pagination

**Predicate builder:**
```javascript
function buildPredicate(condition) {
  if (condition.name === 'ne') {
    const field = condition.args[0]
    const value = String(condition.args[1])
    return (genomeDoc) => {
      if (!genomeDoc) return false
      const docValue = genomeDoc[field]
      if (docValue === undefined || docValue === null) return true
      return String(docValue) !== value
    }
  }
  return () => true
}

function buildCombinedPredicate(conditions) {
  const predicates = conditions.map(buildPredicate)
  return (genomeDoc) => predicates.every(pred => pred(genomeDoc))
}
```

**numFound estimation:**
```javascript
const passRate = filteredDocs.length / docs.length
res.results.response.numFound = Math.max(
  Math.round(originalNumFound * passRate),
  filteredDocs.length
)
```

### 4. `routes/dataType.js` - Register middleware

Insert `GenomePostFilter` after `ExtractCustomFields` (line 242) and before `ContentRange` (line 243). It must run before ContentRange so numFound/docs reflect the filtered state.

```javascript
const GenomePostFilter = require('../middleware/GenomePostFilter')

// In middleware chain:
  APIMethodHandler,
  reqCounter,
  ExtractCustomFields,
  GenomePostFilter,    // <-- NEW
  ContentRange,
  JoinEnrichment,
  media
```

## Key Infrastructure Reused

- **`getJoiner()`** from `middleware/JoinEnrichment.js` (line 280) - lazy singleton for BatchJoiner
- **`BatchJoiner.solrClient`** (line 77 of `lib/BatchJoiner.js`) - public DirectSolrClient property
- **`DirectSolrClient.fetchByIdsAsDict()`** (line 241) - batch lookup by IDs using Solr `{!terms}` parser
- **`JoinEnrichment.getJoinConfig()`** for joinable field configuration

## Known Limitations

- **Facet counts** are computed by Solr before post-filtering, so they include contributions from filtered-out genomes
- **numFound** is estimated (scaled by observed pass rate), not exact
- **Streaming downloads** (`req.isDownload`) and **cursor pagination** (`req.cursorMark`) bypass the post-filter and use the existing join behavior
- If the over-fetch multiplier (3x) isn't enough (>67% of results filtered), the page may have fewer results than requested

## Verification

1. Run existing RQL tests: `cd solrjs.fixed && npx mocha rql.test.genome.js`
2. Start the API server and test the original failing query against alpha Solr
3. Verify the query returns results with `genome(ne(genome_status,Deprecated))`
4. Check `X-Genome-PostFilter` response headers
5. Compare performance vs the `genome(ne(genome_status,Deprecated),eq(genome_id,*))` workaround
