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
const { resolveJoins, JoinTooBroadError } = require('../lib/joinResolver')
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
  return function queryGenome ({ query }) {
    return internalQuery({
      collection: 'genome',
      query,
      queryType: 'solr',
      user: undefined,
      requestId: req && req.requestId
    })
  }
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
        console.log(`[JoinRejected] collection=${req.call_collection} genomes=${err.genomeCount} limit=${err.limit} filter=${err.filter} rid=${req.requestId || '-'}`)
        return next(err)
      }
      // Fail open — see the header. The join stays as it was.
      console.error(`[JoinResolution] lookup failed, leaving join intact: ${err && err.message}`)
      next()
    })
}
