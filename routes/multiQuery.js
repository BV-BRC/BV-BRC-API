const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const BodyParser = require('body-parser')
const debug = require('debug')('p3api-server:route/multiQuery')
const HttpParamsMiddleware = require('../middleware/http-params')
const AuthMiddleware = require('../middleware/auth')
const Expander = require('../ExpandingQuery')
const { internalQuery } = require('../lib/internalQuery')
const { sanitizeErrorMessage } = require('../middleware/RQLQueryParser')

// RQLQueryParser.js:106 caps a non-download query at 25000 rows during RQL→Solr
// conversion. That is NOT internalQuery's default (MAX_LIMIT, 50000, mirroring
// middleware/Limiter.js) — the two caps are separate and the smaller one is what this
// endpoint has always enforced. Verified before converting: `eq(public,true)&limit(30000)`
// returns exactly 25000 rows over HTTP, so passing the default would silently double the
// ceiling on the largest sub-queries.
const MAX_REQUEST_LIMIT = 25000

// Run one sub-query in-process and return the rows.
//
// This used to POST to the API's own listening port. Over a 36h production window those
// self-calls were the top client by a factor of three — 33,101 requests, 33% of all
// traffic, 615,681s cumulative — and they are a resource-loop hazard besides: the outer
// request holds a slot in the same worker pool its children need, so parents can occupy
// every slot while children queue behind them. See PLAN_ELIMINATE_SELF_CALL.md.
//
// Errors still carry a `statusCode`, and the caller still reports it per label. The
// wording keeps the "failed with HTTP <n>" shape it had when there really was an inner
// request: the status is the one the HTTP path would have returned, clients may match on
// the string, and this is meant to be a behavior-preserving conversion.
async function subQuery (dataType, query, opts) {
  // The HTTP path runs this unconditionally (RQLQueryParser.js:101) and internalQuery
  // deliberately does not — it is the resolver that issues self-calls. multiQuery takes
  // arbitrary client RQL, which may contain join() / descendants() / GenomeGroup() /
  // FeatureGroup() / secondDegreeInteraction() / query(), so it has to run here.
  //
  // ResolveQuery throws SYNCHRONOUSLY on malformed RQL — Query(query) at
  // ExpandingQuery.js:291 is called before any promise is created — so `await` alone
  // would not catch it. RQLQueryParser has the same try/catch for the same reason.
  let resolved
  try {
    resolved = await Expander.ResolveQuery(query || '', { req: opts.req, res: opts.res })
  } catch (e) {
    const err = new Error(`sub-query on ${dataType} failed with HTTP 400: ${sanitizeErrorMessage(e.message)}`)
    err.statusCode = 400
    throw err
  }
  // An expansion that resolves to nothing leaves a bare '()', which is not valid RQL.
  // RQLQueryParser.js:103 does exactly this.
  if (resolved === '()') { resolved = '' }

  let results
  try {
    results = await internalQuery({
      collection: dataType,
      query: resolved,
      // Forward the caller's identity: this router already ran authMiddleware, and a
      // sub-query must see the same rows the user would see querying the collection
      // directly. (Contrast dataRouter, which must stay anonymous because its Redis
      // cache key is not user-scoped.)
      user: opts.user,
      maxLimit: MAX_REQUEST_LIMIT,
      requestId: opts.requestId
    })
  } catch (e) {
    const status = e.statusCode || 500
    const err = new Error(`sub-query on ${dataType} failed with HTTP ${status}: ${e.message}`)
    err.statusCode = status
    throw err
  }

  // Shape the return the way the media serializer used to, since there is no longer a
  // content-negotiation step. Only these two accepts were ever usable here: the caller
  // JSON.parse'd the response body, so a CSV or FASTA accept could never have worked.
  if (opts.accept === 'application/solr+json') {
    // media/solr+json.js sends the whole Solr response.
    return results
  }
  // media/json.js, req.call_method === 'query': docs, else grouped, else 404 with no body.
  // Note it puts facet_counts in a *header*, which the old self-call never read — so
  // facets were invisible through this endpoint before and stay invisible now.
  if (results && results.response && results.response.docs) {
    return results.response.docs
  }
  if (results && results.grouped) {
    return results.grouped
  }
  const err = new Error(`sub-query on ${dataType} failed with HTTP 404`)
  err.statusCode = 404
  throw err
}

Router.use(HttpParamsMiddleware)
Router.use(AuthMiddleware)

Router.post('*', [
  BodyParser.json({ extended: true }),
  function (req, res, next) {
    debug('req.body: ', req.body)
    const defs = []
    res.results = {}

    Object.keys(req.body).forEach(function (qlabel) {
      var qobj = req.body[qlabel]
      res.results[qlabel] = {}

      defs.push(subQuery(qobj.dataType, qobj.query, {
        accept: qobj.accept,
        user: req.user,
        requestId: req.requestId,
        // ExpandingQuery reads headers.authorization and memoizes sub-queries on
        // req.queryCache. Sharing one req across the batch therefore also shares that
        // cache, so a join repeated across labels is resolved once instead of once per
        // label. Safe because every label in a batch runs as the same identity.
        req: req,
        res: res
      }).then(function (result) {
        debug('RES: ', qlabel, Array.isArray(result) ? result.length : typeof result)
        res.results[qlabel].result = result
      }, function (err) {
        // Report the failure on that label instead of rejecting the whole batch.
        //
        // Promise.all would be wrong here now that subQuery rejects on non-2xx: one
        // failing panel would take down every other panel in the same request, which
        // is a worse regression than the bug being fixed. Each label is independent,
        // so each reports independently — successful sub-queries still return their
        // rows, and a failed one carries an explicit `error` instead of an error
        // object sitting where the caller expects rows.
        console.error(`[${(new Date()).toISOString()}] multiQuery ${qlabel} (${qobj.dataType}) failed: ${err.message} rid=${req.requestId || '-'}`)
        res.results[qlabel].error = err.message
        if (err.statusCode) {
          res.results[qlabel].status = err.statusCode
        }
      }))
    })

    // Every promise above settles (the rejection handler above absorbs failures), so
    // this resolves once all sub-queries have finished either way.
    Promise.all(defs).then(() => {
      next()
    }, (err) => {
      next(err)
    })
  },

  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = Router
