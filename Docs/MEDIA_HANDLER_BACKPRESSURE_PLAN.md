# Media Handler Backpressure Fix Plan

## Context

The BV-BRC API media handlers (csv.js, tsv.js, json.js, gff.js) use `EventStream.mapSync()` which does NOT handle backpressure. This causes:
- Memory buildup when processing large datasets (millions of rows)
- Potential OOM crashes under load
- Slow-then-burst download behavior (data buffers internally, then flushes at end)

The distributed query system now delivers data much faster than before (5x speedup), making this problem more acute.

## Problem Analysis

### Current Pattern (BAD)
```javascript
results.stream.pipe(EventStream.mapSync((data) => {
  res.write(transformedData)  // Return value IGNORED!
})).on('end', () => res.end())
```

`res.write()` returns `false` when the output buffer is full, but `EventStream.mapSync()` ignores this and continues pulling data, causing unbounded memory growth.

### Working Pattern (Already in codebase)
**File:** `routes/distributedQueryRouter.js` lines 161-175
```javascript
result.stream.on('data', (doc) => {
  const canContinue = res.write(JSON.stringify(doc) + '\n')
  if (!canContinue) {
    result.stream.pause()
  }
})
res.on('drain', () => result.stream.resume())
result.stream.on('end', () => res.end())
```

## Implementation Plan

### Step 1: Create Shared Utility

**New File:** `util/streamWithBackpressure.js`

Create a reusable utility function that:
- Handles the pause/resume pattern for backpressure
- Skips the first document (header/metadata)
- Supports optional header row callback
- Supports transform function for each document
- Handles client disconnect cleanup
- Returns a Promise for async/await usage

```javascript
function streamWithBackpressure(sourceStream, res, options) {
  const { transform, onFirstDoc, onHeader, onEnd, onError } = options

  return new Promise((resolve, reject) => {
    let isFirstDoc = true
    let headerWritten = false
    let docCount = 0

    sourceStream.on('data', (doc) => {
      if (isFirstDoc) {
        isFirstDoc = false
        if (onFirstDoc) onFirstDoc(doc)
        return  // Skip header document
      }

      if (!headerWritten && onHeader) {
        const header = onHeader(doc)
        if (header) {
          const canContinue = res.write(header)
          if (!canContinue) sourceStream.pause()
        }
        headerWritten = true
      }

      const output = transform(doc, docCount++)
      if (output != null) {
        const canContinue = res.write(output)
        if (!canContinue) sourceStream.pause()
      }
    })

    res.on('drain', () => sourceStream.resume())

    sourceStream.on('end', () => {
      if (onEnd) onEnd(docCount)
      res.end()
      resolve(docCount)
    })

    sourceStream.on('error', reject)
    res.on('close', () => {
      if (!res.writableEnded) sourceStream.destroy()
    })
  })
}
```

### Step 2: Update Media Handlers

#### 2.1 JSON Handler (`media/json.js`)

**Lines to modify:** 6-26 (stream handling block)

Change from `EventStream.mapSync` to:
```javascript
if (req.call_method === 'stream') {
  Promise.all([res.results]).then(async (vals) => {
    const results = vals[0]
    let isFirst = true

    res.write('[')
    await streamWithBackpressure(results.stream, res, {
      transform: (data) => {
        const prefix = isFirst ? '' : ','
        isFirst = false
        return prefix + JSON.stringify(data)
      },
      onEnd: () => res.write(']')
    })
  }).catch((error) => {
    next(new Error(`Unable to receive stream: ${error}`))
  })
}
```

#### 2.2 CSV Handler (`media/csv.js`)

**Lines to modify:** 18-56 (stream handling block)

```javascript
if (req.call_method === 'stream') {
  Promise.all([res.results]).then(async (vals) => {
    const results = vals[0]
    let localFields = fields

    await streamWithBackpressure(results.stream, res, {
      onHeader: (firstDoc) => {
        if (!localFields) localFields = Object.keys(firstDoc)
        return (header || localFields).join(',') + '\n'
      },
      transform: (data) => {
        const row = localFields.map((field) => {
          // ... existing field formatting logic ...
        })
        return row.join(',') + '\n'
      }
    })
  }).catch((error) => {
    next(new Error(`Unable to receive stream: ${error}`))
  })
}
```

#### 2.3 TSV Handler (`media/tsv.js`)

**Lines to modify:** 16-54 (stream handling block)

Same pattern as CSV, using `'\t'` delimiter.

#### 2.4 GFF Handler (`media/gff.js`)

**Lines to modify:** 57-84 (stream handling block)

```javascript
if (req.call_method === 'stream') {
  Promise.all([res.results]).then(async (vals) => {
    const results = vals[0]

    await streamWithBackpressure(results.stream, res, {
      onHeader: (firstDoc) => {
        let header = '##gff-version 3\n'
        header += `#Genome: ${firstDoc.genome_id}\t${firstDoc.genome_name}`
        if (firstDoc.product) header += ` ${firstDoc.product}`
        return header + '\n'
      },
      transform: (data) => serializeRow(data)
    })
  }).catch((error) => {
    next(new Error(`Unable to receive stream: ${error}`)
  })
}
```

### Step 3: Add NDJSON Format (Optional Enhancement)

**New File:** `media/ndjson.js`

NDJSON is superior for streaming large datasets:
- No array wrapper needed
- Each line is independent
- Already used in `distributedQueryRouter.js`

```javascript
const { streamWithBackpressure } = require('../util/streamWithBackpressure')

module.exports = {
  contentType: 'application/x-ndjson',
  serialize: function (req, res, next) {
    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.ndjson`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then(async (vals) => {
        await streamWithBackpressure(vals[0].stream, res, {
          transform: (doc) => JSON.stringify(doc) + '\n'
        })
      }).catch((error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else if (req.call_method === 'query') {
      if (res.results?.response?.docs) {
        res.results.response.docs.forEach((doc) => {
          res.write(JSON.stringify(doc) + '\n')
        })
      }
      res.end()
    } else {
      res.write(JSON.stringify(res.results?.doc || res.results?.docs) + '\n')
      res.end()
    }
  }
}
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `util/streamWithBackpressure.js` | CREATE | Shared backpressure utility |
| `media/json.js` | MODIFY | Update stream block (lines 6-26) |
| `media/csv.js` | MODIFY | Update stream block (lines 18-56) |
| `media/tsv.js` | MODIFY | Update stream block (lines 16-54) |
| `media/gff.js` | MODIFY | Update stream block (lines 57-84) |
| `media/ndjson.js` | CREATE | New NDJSON format (optional) |
| `tests/test-util/test.streamWithBackpressure.spec.js` | CREATE | Unit tests |

## Existing Code to Reuse

- **Backpressure pattern:** `routes/distributedQueryRouter.js` lines 161-175
- **Field formatting:** Keep existing `encapsulateStringArray()` and field transformation in csv.js/tsv.js
- **GFF serialization:** Keep existing `serializeRow()` function in gff.js
- **Query method handling:** Leave `req.call_method === 'query'` blocks unchanged

## Verification Plan

### Unit Tests
```bash
# Run new utility tests
npx mocha tests/test-util/test.streamWithBackpressure.spec.js
```

### Regression Tests
```bash
# Run existing media tests to verify output format unchanged
npm run test-media
```

### Manual Backpressure Test
```bash
# Terminal 1: Monitor memory
watch -n 1 'ps -o rss,vsz,pid,command -p $(pgrep -f "node.*app.js")'

# Terminal 2: Large download
curl -X POST http://localhost:3001/genome_feature/ \
  -H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
  -H "Accept: text/csv" \
  -H "download: true" \
  -d "eq(genome_id,83332.12)&limit(1000000)" > /dev/null

# Verify: Memory should stay flat (< 100MB growth) during download
```

### Streaming Behavior Test
```bash
# Watch download progress - should be steady, not slow-then-burst
curl -X POST http://localhost:3001/genome_feature/ \
  -H "Accept: text/csv" \
  -d "eq(genome_id,83332.12)&limit(100000)" \
  --progress-bar -o /dev/null
```

## Success Criteria

1. All existing `test-media` tests pass unchanged
2. Memory stays bounded during large downloads (< 100MB growth)
3. No "slow-then-burst" behavior - data streams smoothly
4. Client disconnects properly clean up streams
5. Output format identical to current behavior
