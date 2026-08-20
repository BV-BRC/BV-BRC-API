# BUG — a failed streaming download returns HTTP 200 with an empty body

**Component:** Data API (`p3_api`) — `lib/solrjs/index.js:170-173` (and five sibling
`stream.emit('end')` sites in the same function)
**Severity:** moderate. Silent data loss: the caller receives a well-formed, empty,
successful-looking download instead of an error.
**Status:** open, not fixed. Pre-existing; predates the cross-collection download work.
Reproduced against a live API 2026-08-07.

---

## Summary

When a Solr request inside a streaming download fails, `_streamQuery` logs to the server
console and emits `end` on the result stream. The media serializer sees a stream that
finished normally with no documents, writes nothing, and the client gets:

```
HTTP/1.1 200 OK
Content-Type: text/csv
Content-Disposition: attachment; filename="BVBRC_genome_feature.csv"
<0 bytes>
```

There is nothing in the response to distinguish "your filter matched nothing" from "the
query failed." A user sees an empty file and reasonably concludes there were no results.

## Reproduction

The easiest trigger is a streaming download with no `sort()`:

```bash
# 200, ZERO bytes -- the query actually failed
curl -sD- -o/dev/null 'http://localhost:3001/genome_feature/?eq(genome_id,83332.12)\
&select(patric_id)&limit(5)&http_download=true&http_accept=text/csv'

# 200, 5 rows -- identical query plus a sort
curl -s 'http://localhost:3001/genome_feature/?eq(genome_id,83332.12)\
&select(patric_id)&sort(%2Bfeature_id)&limit(5)&http_download=true&http_accept=text/csv'
```

The server log shows what the client never sees:

```
Unable to complete stream query: Error: ... Cursor functionality requires a sort
containing a uniqueKey field tie breaker
```

## Mechanism

`solrjs.stream()` paginates with `cursorMark`. Solr rejects `cursorMark` (HTTP 400) unless
the sort includes the collection's uniqueKey. `_streamQuery`'s rejection handler
(`lib/solrjs/index.js:170-173`):

```js
}, (err) => {
  console.error(`Unable to complete stream query: ${err}`)
  stream.emit('end')      // <-- indistinguishable from a clean finish
  callback()
})
```

**The missing-sort case is only the most reachable trigger.** That handler catches *any*
rejected Solr request in the pagination loop — a shard failure, a timeout, a malformed
`fq`, a connection reset mid-download. All of them surface as an empty successful
download. There are six `stream.emit('end')` sites in the function (lines 123, 147, 152,
162, 166, 172); line 172 is the error path, and line 123 (`No Response Body`) is similarly
indistinguishable from success.

This is the same defect class as the empty-200-on-shard-failure behavior found during
query-replay testing. Fixing it here fixes both.

## Who is affected

- **Not the website.** `DownloadExecutor.buildQuery` always appends a sort ending in the
  collection's uniqueKey (`DownloadExecutor.js:100-113`), with a comment citing this exact
  Solr constraint. It is immune to the common trigger — though not to the general one
  (a shard failure still yields a silent empty file).
- **CLI users, scripts, and hand-written download URLs** hit the missing-sort trigger
  immediately, and get no signal that anything went wrong.
- **The cross-collection download path is immune to the sort trigger**: it builds its own
  cursor sort via `CrossCollectionSourceStream.buildCursorSort`, appending the uniqueKey
  rather than trusting the caller. That is the pattern the fix below generalizes.

## Suggested fix

Two independent changes; the second is worth doing regardless of the first.

**1. Give the stream an error channel (the real fix).**

Emit `error` rather than (or in addition to) `end` on failure, and have the media
serializers propagate it. This is a **behavior change for every `.stream()` consumer** —
Node destroys the process on an unhandled `'error'` event, so every call site needs an
attached handler before this lands. Audit `media/*.js`, `middleware/APIMethodHandler.js`,
and `middleware/DistributedQuery.js` first.

Once the response has begun streaming, headers are already committed and a clean status
code is no longer possible. The best available behavior is to destroy the connection so
the client sees a truncated transfer rather than a plausible complete file — abandoning
the download loudly beats finishing it quietly. Before the first byte, a 500 with a JSON
body is achievable.

**2. Stop generating the most common failure (cheap, independent).**

Have `RQLQueryParser` ensure the sort contains the uniqueKey for download/stream requests,
exactly as `ensureSortHasUniqueKey` already does for explicit `cursor()` requests
(`middleware/RQLQueryParser.js:36-59`) and as the cross-collection stream does for its own
cursor. The machinery and the `collectionUniqueKeys` map (`config.js:102`) both already
exist; this is wiring an existing helper into one more path.

This removes the trigger that users actually hit, without touching stream error semantics.
Do it first.

## Tests to add

- A streaming download with no `sort()` returns rows (after fix 2), rather than an empty
  200.
- A streaming download whose Solr query fails does **not** return a 200 with an empty body
  (after fix 1) — simulate by pointing at a nonexistent collection or forcing a 400.
- Assert on **row counts**, not on "response was received." Every bug in this class
  produces a well-formed response; only a count comparison distinguishes them.
