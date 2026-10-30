# Proposal: `http_filter_cache` — let the caller declare paging intent

**Status:** proposal, not implemented.
**Context:** `Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md` §4.1a, and TODO-13.

## The problem

The join rewrite emits a `{!terms}` filter, and whether that filter should be **cached**
depends on something the server cannot reliably see: will the caller come back for more
pages?

Measured on *E. coli* (3,754 subtree taxa, 4,894 deprecated ids), `genome_sequence`:

| workload | `cache=true` | `cache=false` |
|---|---|---|
| `cursorMark`, 12 pages × 1000 | **786 ms** median | 1,017 ms |
| `start=`, 8 pages × 25 (interleaved A/B) | **180 ms** median | 381 ms |

Caching wins by ~2× when the filter is reused. But the opposite finding is also real and
already recorded in CLAUDE.md: for a **one-shot** id list racing a *scored* `q=`, a cached
filter measured **3,952 ms against 676 ms uncached** — Solr materialises the DocSet up
front and then drives iteration from the scored query instead of letting the selective
terms clause lead.

So neither setting is right in general. The two workloads want opposite things.

## Why the server cannot infer it

`resolveJoins(solrQuery, {queryGenome, collection})` sees only the query string
(`lib/joinResolver.js:241`). `middleware/JoinResolution.js:75` has the whole `req` and so
could pass more down, but even there the signals are incomplete:

| signal | available? | tells us |
|---|---|---|
| `req.call_method === 'stream'`, `req.isDownload` | yes (`routes/dataType.js:90`) | will page — `_streamQuery` loops on `cursorMark` (`lib/solrjs/index.js:159`) |
| `&start=N`, N > 0 | yes (`lib/solrjs/rql.js:30`) | already paging |
| `rows=0` with facets, or `rows=1` | yes | cannot page — genuine one-shot |
| **`start=0`, `rows=25`** | — | **ambiguous: grid page 1, or a one-shot** |

The ambiguous case is the common one. A grid's first request is byte-identical to a
one-shot; the difference only materialises when a second request arrives. `QueryClassifier`
faces the same problem and resolves it with heuristics, which is acceptable for admission
but produces a measurable 2× penalty here either way it guesses.

**The caller knows.** A grid knows it paginates. A download knows it will cursor. A
`summary_by_taxon` facet count knows it is one-shot. That information exists at the call
site and is thrown away.

## Proposed flag

```
http_filter_cache = auto | true | false        (default: auto)
```

- **`true`** — the caller will re-send this filter (grid paging, cursor download).
- **`false`** — one-shot; do not pay to materialise a DocSet that is used once.
- **`auto`** — server heuristic, as described below. Default, so nothing changes for
  existing clients.

### Transport

Follows the existing namespaced-param convention in `middleware/http-params.js`, which
already captures `http_fasta_*`, `http_genbank_*` and `http_source_*` into per-feature
buckets and **deletes them before the query reaches Solr**. Add:

```js
req.filterParams = {}
...
if (key.match(/^http_filter_/)) {
  req.filterParams[key] = decodeURIComponent(parsed[key])
  delete parsed[key]
  return
}
```

Deliberately *not* added to `ALLOWED_HEADERS`: this is not a header, it is a hint consumed
by `JoinResolution`, exactly as `http_source_*` is consumed by `CrossCollectionSource`.

### Plumbing

`middleware/JoinResolution.js` reads it and passes an explicit value down; `resolveJoins`
gains one option and uses it at the emit site (`lib/joinResolver.js:296`):

```js
// JoinResolution.js
resolveJoins(req.call_params[0], {
  queryGenome: makeGenomeQuery(req),
  collection: req.call_collection,
  filterCache: resolveFilterCacheHint(req)   // true | false
})

// joinResolver.js:296
const cacheDirective = opts.filterCache ? 'cache=true' : 'cache=false'
const replacement = `&fq={!terms f=${join.toField} ${cacheDirective}}${ids.join(',')}`
```

### The `auto` heuristic

Used when the caller says nothing. **Default to `true`**, because the two mistakes are not
symmetric:

- caching a one-shot: pays one DocSet build, used once;
- not caching a paged query: **every page rebuilds** — measured 1,017 vs 786 ms per page,
  across potentially 60+ pages.

Override to `false` only on shapes that provably cannot page:

```
rows=0 (a facet-only count, e.g. summary_by_taxon)   -> cache=false
rows=1                                                -> cache=false
otherwise                                             -> cache=true
```

**Resolved 2026-10-26 — a scored `q=` is reachable, but does not reverse the default.**

It *is* reachable: of 67 join queries captured in the production logs, 17 carried a real
scored clause beyond the trivial `genome_id:*`:

```
  26  q=genome_id:*
  23  q=*:*
   7  q=(genome_id:* AND (resistant_phenotype:(Resistant OR Susceptible OR Intermediate)))
   4  q=(genome_id:* AND annotation:"PATRIC")
   2  q=(genome_id:* AND (source:"CARD" AND property:"Antibiotic Resistance"))
   …
```

So the CLAUDE.md degradation shape — a big `{!terms}` filter losing a race against a
scored query — is not hypothetical for this rewrite. Measured anyway, one-shot
(`rows=1`), scored `q=(genome_id:* AND sequence_type:contig)`, interleaved, 5 reps:

```
  cache=true    [1185, 778, 777, 813, 518]   median 778 ms
  cache=false   [ 965, 870, 1258, 937,  80]  median 937 ms
```

Caching is still *faster*, not slower. The 676-vs-3,952 ms result does not reproduce here,
most likely because that measurement used a 6,000-id `feature_id` list against a scored
clause of similar selectivity, whereas the taxon filter is far more selective than the
accompanying clause and leads the intersection either way. **The `cache=true` default
therefore stands even for the scored shape.** Re-measure if a caller appears whose scored
clause is more selective than the taxon subtree.

## Who sets it

| caller | value | why |
|---|---|---|
| web grid | `true` | pages through results |
| streaming download | `true` | `_streamQuery` cursors by construction |
| `routes/dataRouter.js:139` (`summary_by_taxon`) | `false` | `rows=0`, facet counts, one shot |
| P3DataAPI `query_cb` | `true` | chunked `limit(25000)` fetches |
| anything unaware | *(omits it)* | `auto` |

The streaming case could also be set server-side from `req.isDownload`, since that is
already known — the flag matters most for the grid, where only the client knows.

## Scope

Small: one regex in `http-params.js`, one option threaded through `JoinResolution` →
`resolveJoins`, one string at the emit site. Backward compatible — omitting the parameter
preserves today's behaviour, and the `auto` default changes `cache=false` → `cache=true`
only for queries that already take the rewrite path.

## What this does not address

The deep-paging curve is independent of this flag and much larger. On the same filter with
`cache=true`:

```
start=       0    136 ms
start=   2,500    611 ms
start=  25,000  1,551 ms
start= 250,000  7,701 ms
start=1,000,000 25,012 ms
```

`cursorMark` has no such curve — **60 pages × 2,000 rows = 120,000 docs, drift 0.99×**
(median of the first ten pages 1,044 ms, of the last ten 1,032 ms). Purging deep paging is
worth more than this flag; the flag is worth ~2× on top.

Also note `Limiter.detectFixedIdCount` will match a `{!terms f=taxon_id}` filter and cap
`rows` to `idCount + 10`. That is correct for a `genome_id` terms filter, where the count
bounds the result set, and **wrong** for a `taxon_id` one — 3,754 taxa correspond to
21.8 M sequences. The pattern needs to distinguish the two before this ships.
