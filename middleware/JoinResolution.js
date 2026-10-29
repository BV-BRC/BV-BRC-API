/**
 * JoinResolution middleware — admission control for cross-collection joins.
 *
 * Refuses a `{!join method=crossCollection fromIndex=genome ...}` whose genome set is too
 * large to be safe, and rewrites one small enough into a local `{!terms}` filter. The
 * reasoning, measurements and thresholds live in lib/joinResolver.js; this file is only
 * the wiring.
 *
 * PLACEMENT (routes/dataType.js)
 *
 *   RQLQueryParser      <- emits the {!join ...} clause
 *   SolrQuerySanitizer
 *   DecorateQuery       <- adds the permission fq to the OUTER query
 *   Limiter
 *   CrossCollectionSource
 *   JoinResolution      <- here
 *   JoinFieldInjector
 *   DistributedQuery    <- must see the final query to route correctly
 *   ...
 *
 * After DecorateQuery so the outer permission filter is already attached and untouched by
 * the rewrite, and before DistributedQuery because rewriting a join to {!terms} changes
 * the query that path will execute.
 *
 * FAIL-OPEN, EXCEPT FOR THE REJECT
 *
 * If the genome lookup itself fails — Solr down, timeout, malformed response — the join
 * is left exactly as it was and the request proceeds. The pre-existing behavior is the
 * safe fallback: this middleware exists to make things better, and it must not turn a
 * Solr blip into a failed request that would otherwise have worked.
 *
 * The one deliberate exception is JoinTooBroadError, which is the entire point: that
 * query is refused with 400 rather than allowed to reach Solr.
 */

const debug = require('debug')('p3api-server:middleware/JoinResolution')
const { resolveJoins, findJoins, JoinTooBroadError } = require('../lib/joinResolver')
const BatchedJoinStream = require('../lib/BatchedJoinStream')
const Config = require('../config')
const { internalQuery } = require('../lib/internalQuery')

/**
 * Genome lookup used to count and resolve a join's filter.
 *
 * Deliberately anonymous (`user: undefined`), matching what the join it replaces does:
 * `{!join fromIndex=genome}` matches genomes irrespective of permission, and private data
 * stays protected by the permission fq DecorateQuery already put on the outer query. See
 * the header of lib/joinResolver.js for why adding a filter here would be a correctness
 * regression rather than a security improvement.
 */
function makeGenomeQuery (req) {
  return makeCollectionQuery(req, 'genome')
}

/** Same, against `taxonomy`, for the taxon-subtree rewrite. */
function makeTaxonomyQuery (req) {
  return makeCollectionQuery(req, 'taxonomy')
}

function makeCollectionQuery (req, collection) {
  return function query ({ query: q }) {
    return internalQuery({
      collection,
      query: q,
      queryType: 'solr',
      user: undefined,
      requestId: req && req.requestId
    })
  }
}

/**
 * Should the emitted {!terms} filter be cached?
 *
 * The caller knows and the server often cannot: a grid's FIRST page is byte-identical to
 * a one-shot (`start=0`, `rows=25`), and the difference only appears when a second
 * request arrives. So `http_filter_cache` lets the caller say. See
 * Docs/PROPOSAL-http-filter-cache-hint.md.
 *
 *   true   caller will re-send this filter (grid paging, cursor download)
 *   false  one-shot; do not materialise a DocSet that is used once
 *   auto   (default, or absent) infer below
 *
 * The `auto` inference defaults to CACHED, because the mistakes are asymmetric: caching a
 * one-shot pays one DocSet build, whereas not caching a paged query rebuilds on every
 * page. It only says `false` for shapes that provably cannot page.
 *
 * @returns {boolean}
 */
function resolveFilterCacheHint (req) {
  const raw = req.filterParams && req.filterParams.http_filter_cache
  if (raw !== undefined) {
    const v = String(raw).trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
    // anything else, including 'auto', falls through to the inference
  }

  // Downloads and streams cursor by construction (lib/solrjs/index.js _streamQuery).
  if (req.isDownload || req.call_method === 'stream') return true

  const q = (req.call_params && req.call_params[0]) || ''
  // rows=0 is a facet-only count (the summary_by_taxon shape) and rows=1 is a probe;
  // neither can page, so neither benefits from a cached DocSet.
  if (/[&?]rows=0(?:&|$)/.test(q)) return false
  if (/[&?]rows=1(?:&|$)/.test(q)) return false

  return true
}

/**
 * Is this a bulk download, as opposed to a page the user is looking at?
 *
 * Only these may take the slow batched path. A grid page must stay fast or fail fast —
 * nobody wants a 25-row page that takes five minutes — whereas a download is already
 * understood to be a long operation, and "slow but reliable" beats "refused".
 */
function isBulkDownload (req) {
  return !!(req.isDownload || req.call_method === 'stream')
}

function batchedDownloadsEnabled () {
  const cfg = Config.get('joinResolution') || {}
  return cfg.batchedDownloads === true
}

/**
 * Replace the refused query with a batched stream over the same join.
 *
 * Sets `res.results = { stream }` and `req.skipAPIMethodHandler`, the contract
 * middleware/CrossCollectionStream.js already uses, so the media serializers consume it
 * exactly as they would an ordinary streaming result.
 */
function attachBatchedJoinStream (req, res, err) {
  const q = req.call_params[0]
  const joins = findJoins(q)
  if (joins.length !== 1) {
    // Two joins would need a nested walk and nothing emits that today; refusing is
    // honest, and cheaper than a resolver nobody exercises.
    throw new Error(`expected exactly one join, found ${joins.length}`)
  }
  const join = joins[0]

  // Everything the caller asked for EXCEPT the join clause has to ride along, or the
  // download silently returns more rows than the request described.
  const params = new URLSearchParams(q.replace(join.match, ''))
  const extraFq = params.getAll('fq').filter(Boolean)
  const fl = params.get('fl') || undefined

  // The caller's sort MUST ride along. Omitting it does not merely lose ordering: an
  // unsorted Solr fetch returns internal docid order, which varies by replica, so the
  // per-slice `rows` cap selected an arbitrary and different subset on every run. Three
  // runs of one limit(5000) Viruses download on alpha returned 5000 records each with
  // ~75% of the ids differing. See "ORDERING" in lib/BatchedJoinStream.js for what this
  // does and does not guarantee.
  const sort = params.get('sort') || undefined

  // The caller's row limit MUST reach the stream. Without it the walk runs to the end of
  // the genome set regardless: a `limit(100)` download of Bacteria (1,316,755 genomes)
  // traversed all 264 slices before emitting anything, and Cloudflare cut it at 125s with
  // zero bytes — turning a fast 400 into a slow dead end, which is worse for the user.
  const rowsParam = parseInt(params.get('rows'), 10)
  const maxRows = Number.isFinite(rowsParam) && rowsParam > 0 ? rowsParam : undefined

  const stream = new BatchedJoinStream({
    queryGenome: makeGenomeQuery(req),
    queryTarget: makeCollectionQuery(req, req.call_collection),
    genomeFilter: join.filter,
    toField: join.toField,
    extraFq,
    fl,
    sort,
    maxRows
  })

  // The client going away must stop the pumping, not leave it walking a 748-batch cursor
  // for a response nobody will read.
  res.once('close', () => { if (!res.writableEnded) stream.destroy() })

  res.results = { stream }
  req.skipAPIMethodHandler = true
  res.locals = res.locals || {}
  res.locals.batchedJoin = { genomeCount: err.genomeCount, filter: err.filter }
}

module.exports = function JoinResolution (req, res, next) {
  // Only query/stream carry a Solr query string worth inspecting.
  if (req.call_method !== 'query' && req.call_method !== 'stream') {
    return next()
  }
  if (!req.call_params || typeof req.call_params[0] !== 'string') {
    return next()
  }
  // Cheap guard: skip the work entirely for the overwhelming majority of queries, which
  // carry no join at all.
  if (req.call_params[0].indexOf('crossCollection') === -1) {
    return next()
  }

  resolveJoins(req.call_params[0], {
    queryGenome: makeGenomeQuery(req),
    queryTaxonomy: makeTaxonomyQuery(req),
    filterCache: resolveFilterCacheHint(req),
    collection: req.call_collection
  })
    .then((result) => {
      if (!result.unchanged) {
        debug(`rewrote ${result.rewrites.length} join(s) for ${req.call_collection}`)
        req.call_params[0] = result.query
        // Record for /stats-style introspection and for the trace-replay harness, which
        // needs to know whether a query took the rewritten path.
        res.locals = res.locals || {}
        res.locals.joinRewrites = result.rewrites
      }
      next()
    })
    .catch((err) => {
      if (err instanceof JoinTooBroadError) {
        // A DOWNLOAD does not have to be refused. The cap protects the single-{!terms}
        // rewrite, whose filter body grows linearly with the genome count; a download can
        // instead resolve the join in bounded slices, which measured roughly FLAT in
        // slice size because the cost tracks the total id count rather than how it is cut
        // up. See lib/BatchedJoinStream.js for the numbers.
        if (isBulkDownload(req) && batchedDownloadsEnabled()) {
          try {
            attachBatchedJoinStream(req, res, err)
            console.log(`[JoinBatched] collection=${req.call_collection} genomes=${err.genomeCount} filter=${err.filter} rid=${req.requestId || '-'}`)
            return next()
          } catch (e) {
            // Fall through to the rejection: a download that cannot be set up is better
            // refused with the actionable 400 than failed obscurely mid-stream.
            console.error(`[JoinBatched] setup failed, refusing instead: ${e && e.message}`)
          }
        }
        console.log(`[JoinRejected] collection=${req.call_collection} genomes=${err.genomeCount} limit=${err.limit} filter=${err.filter} rid=${req.requestId || '-'}`)
        return next(err)
      }
      // Fail open — see the header. The join stays as it was.
      console.error(`[JoinResolution] lookup failed, leaving join intact: ${err && err.message}`)
      next()
    })
}

module.exports.resolveFilterCacheHint = resolveFilterCacheHint
