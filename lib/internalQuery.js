/**
 * internalQuery — run a collection query in-process, without an HTTP round trip.
 *
 * Replaces the `httpRequest({ port: Config.get('http_port') })` pattern used by
 * routes/multiQuery.js, routes/dataRouter.js, and ExpandingQuery.js, where the API calls
 * its own listening port. Measured over 36h of production traffic, those self-calls were
 * the top client by a factor of three: 33,101 requests (33% of all traffic), 615,681s
 * cumulative. See PLAN_ELIMINATE_SELF_CALL.md.
 *
 * Beyond the wasted round trip, the self-call pattern is a resource-loop hazard: an outer
 * request occupies a slot in the same worker pool its children need, so under load the
 * parents can hold every slot while the children queue behind them.
 *
 * WHY DIRECT-SOLR AND NOT A SYNTHETIC req/res
 * -------------------------------------------
 * The obvious alternative is to fake a req/res pair and push it through the real
 * `/:dataType/` chain. That chain is ~27 middleware deep and its hard dependencies are
 * exactly what a fake object gets wrong: body parsers reading the raw request stream, the
 * raw-stream auth extractor at routes/dataType.js:34, `res.format(media)` (real Express
 * content negotiation), `res.on('close'|'finish'|'drain')` in DistributedQuery and
 * CrossCollectionStream, and `req.connection.remoteAddress` in SolrQuerySanitizer. A
 * synthetic dispatcher would have to emulate all of it and would drift from the real
 * chain over time.
 *
 * The callers being converted need only four things: RQL→Solr conversion, a permission
 * filter, a row cap, and parsed docs. So this goes straight to Solr, following the
 * precedent set when media/genbank.js was converted (commit 06dd7618). Like that one it
 * uses the standard `Solrjs` client rather than `DirectSolrClient`: these are small
 * targeted queries that gain nothing from parallel shard fan-out, and DirectSolrClient
 * requires network access to every replica, which the deployment does not have.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No media serialization (callers get parsed objects, not CSV/TSV/FASTA), no streaming,
 * no join enrichment, no cross-collection download resolution. A caller needing any of
 * those still belongs on the real middleware chain.
 */

const Solrjs = require('./solrjs')
const Rql = require('./solrjs/rql')
const Config = require('../config')
const Web = require('../web')
const { buildPermissionFq } = require('./permissionFilter')
const { publicFree: DEFAULT_PUBLIC_FREE } = require('../middleware/PublicDataTypes')
const { sanitizeQueryString } = require('../middleware/SolrQuerySanitizer')
// From lib/, not middleware/RQLQueryParser — requiring the middleware from here closes a
// cycle through ExpandingQuery, which now calls this module. See lib/sanitizeErrorMessage.js.
const sanitizeErrorMessage = require('./sanitizeErrorMessage')
const debug = require('debug')('p3api-server:internalQuery')

const SOLR_URL = Config.get('solr').url

// Mirrors middleware/Limiter.js. Not imported from there because Limiter is an Express
// middleware that mutates req in place rather than exporting its constants.
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50000

// Matches the timeout on the main data path (middleware/APIMethodHandler.js). Without a
// timeout, a Solr connection that is accepted but never answered — classically a pooled
// keepAlive socket the far side has already dropped, which leaves no FIN — hangs until the
// OS tears down the TCP session. See Docs/GENBANK_DOWNLOAD_PERFORMANCE.md.
const SOLR_REQUEST_TIMEOUT_MS = process.env.SOLR_REQUEST_TIMEOUT_MS !== undefined
  ? parseInt(process.env.SOLR_REQUEST_TIMEOUT_MS, 10)
  : 120000

// Built once, shared. Same pooled agent APIMethodHandler uses.
let sharedAgent = null
function getAgent () {
  if (!sharedAgent) {
    sharedAgent = Web.getSolrAgent()
  }
  return sharedAgent
}

/**
 * Reject a collection that is not configured.
 *
 * SECURITY: the HTTP path gates the collection name at app.js:187 via
 * `app.param('dataType')`, which 404s anything not in `Config.get('collections')`.
 * Callers like multiQuery build the target from client-supplied input
 * (`req.body[label].dataType`), so bypassing HTTP also bypasses that gate. This
 * reinstates it. Without it, a caller could aim an in-process query at an arbitrary
 * Solr core.
 */
function assertKnownCollection (collection) {
  const collections = Config.get('collections') || []
  if (!collection || collections.indexOf(collection) === -1) {
    const err = new Error(`Unknown collection: ${collection}`)
    err.statusCode = 404
    throw err
  }
}

/**
 * Run a query against one collection, in-process.
 *
 * @param {Object}   opts
 * @param {string}   opts.collection  Target collection; must be in config `collections`.
 * @param {string}   opts.query       RQL (default) or a raw Solr query string.
 * @param {string}   [opts.queryType] 'rql' (default) or 'solr'.
 * @param {string}   [opts.user]      Authenticated user id, or undefined for anonymous.
 *                                    Drives the permission fq — see the note below.
 * @param {string[]} [opts.publicFree] Permission-exempt collections. Defaults to the same
 *                                    list PublicDataTypes assigns; pass explicitly only to
 *                                    override.
 * @param {number}   [opts.maxLimit]  Row cap for RQL conversion. Default MAX_LIMIT.
 * @param {number}   [opts.timeout]   Per-call Solr timeout in ms.
 * @param {string}   [opts.requestId] Tagged onto the Solr query as `appRid` for log
 *                                    correlation, the same way middleware/Limiter.js does
 *                                    it on the HTTP path.
 * @returns {Promise<Object>} The raw Solr response: `{ response: { docs, numFound }, ... }`
 *                            plus `facet_counts` / `grouped` when the query asked for them.
 *                            Returned whole rather than unwrapped because dataRouter needs
 *                            facets and grouped output, not just docs.
 *
 * PERMISSION SCOPING — the part to get right.
 * `user` is what decides visibility. Omit it and the query is anonymous (`fq=public:true`);
 * pass it and the caller sees their own private rows. Neither is a safe default for every
 * caller, so it is explicit at every call site:
 *   - multiQuery forwards the caller's identity (it already ran authMiddleware);
 *   - dataRouter passes nothing on purpose — its results are cached in Redis under a key
 *     that is NOT user-scoped, so inheriting an identity would leak private counts into a
 *     shared cache.
 * `publicFree` defaults rather than being required because buildPermissionFq fails CLOSED
 * without it (lib/permissionFilter.js:37 requires an array), which would silently
 * over-filter exempt collections. The default comes from the same module the middleware
 * uses, so the two cannot drift.
 */
async function internalQuery (opts) {
  const {
    collection,
    query = '',
    queryType = 'rql',
    user,
    publicFree = DEFAULT_PUBLIC_FREE,
    maxLimit = MAX_LIMIT,
    timeout,
    requestId
  } = opts || {}

  assertKnownCollection(collection)

  let solrQuery
  if (queryType === 'solr') {
    solrQuery = query
  } else {
    // Deliberately NOT running ExpandingQuery.ResolveQuery here. That resolver is what
    // issues the self-calls this module exists to remove, and it needs a req/res pair.
    // Callers passing RQL that contains join()/GenomeGroup()/secondDegreeInteraction()
    // must resolve those first — multiQuery does, in routes/multiQuery.js.
    try {
      solrQuery = Rql(query || '').toSolr({
        maxRequestLimit: maxLimit,
        defaultLimit: DEFAULT_LIMIT,
        collection
      })
    } catch (e) {
      // Malformed RQL and unknown operators are client errors, and the HTTP path answers
      // both with 400 (middleware/RQLQueryParser.js:136,141). Without this they would
      // reach callers as an unclassified throw, and a caller that keys off `statusCode`
      // — multiQuery reports it per label — would report a 500 for a bad client query.
      const err = new Error(sanitizeErrorMessage(e.message))
      err.statusCode = 400
      throw err
    }
  }

  // SECURITY: the same gate middleware/SolrQuerySanitizer.js applies on the HTTP path,
  // where it sits immediately after RQLQueryParser — so it screens the *converted* Solr
  // string, not the raw RQL, and this has to run at the same point for the same reason.
  //
  // Not redundant with RQL conversion. A dangerous parameter cannot be written as a bare
  // RQL term (`shards=http://x` dies earlier as "Unknown converter http"), but it can be
  // smuggled through an RQL *value* as `%26shards%3D…`, single- or multiply-encoded, and
  // become a separate parameter at Solr's decoding layer. Verified against the live HTTP
  // path: five such payloads are rejected there today, including a double-encoded one.
  // That is the vulnerability the sanitizer's own header calls "TIKI-W094-8: SSRF in
  // multi query endpoint via Solr Injection" — the multi-query endpoint being precisely
  // the first caller converted to this module.
  const { sanitized, blockedParams } = sanitizeQueryString(solrQuery)
  if (blockedParams.length > 0) {
    const unique = [...new Set(blockedParams)]
    console.log(`[SECURITY] internalQuery blocked dangerous Solr params: ${unique.join(', ')} collection=${collection} user=${user || '<anon>'} rid=${requestId || '-'}`)
    const err = new Error('Request contains prohibited query parameters')
    err.statusCode = 400
    throw err
  }
  solrQuery = sanitized

  // Same fq DecorateQuery appends on the HTTP path — one source of truth, so the
  // in-process and HTTP paths cannot diverge.
  const permissionFq = buildPermissionFq({ collection, user, publicFree })
  if (permissionFq) {
    solrQuery = solrQuery + '&fq=' + permissionFq
  }

  // Matches the tag middleware/Limiter.js adds, so an in-process query is still
  // correlatable in the Solr logs. 'appRid' rather than 'rid' avoids colliding with
  // Solr's own internal parameter.
  if (requestId) {
    solrQuery = solrQuery + '&appRid=' + encodeURIComponent(requestId)
  }

  const solrClient = new Solrjs(SOLR_URL + '/' + collection)
  solrClient.setAgent(getAgent())
  const timeoutMs = timeout !== undefined ? timeout : SOLR_REQUEST_TIMEOUT_MS
  if (timeoutMs) {
    solrClient.timeout = timeoutMs
  }
  if (user) {
    solrClient.setHeaders({ 'X-Authenticated-User': user })
  }

  debug(`query collection=${collection} user=${user || '<anon>'} q=${solrQuery}`)

  let results
  try {
    results = await solrClient.query(solrQuery)
  } catch (e) {
    // A timeout arrives as a bare Error from armTimeout() in lib/solrjs/index.js, with no
    // statusCode, so callers keying off statusCode would report it as a 500 — i.e. as a
    // fault in this service rather than upstream unresponsiveness. Classify it as 504 so
    // the distinction survives to the client and the access log.
    //
    // Matched on the message because that is the only signal the client provides;
    // req.destroy(err) surfaces through req.on('error'), which wraps the original.
    // Keep this string in sync with armTimeout's `Solr request timed out after ${n}ms`.
    if (e && typeof e.message === 'string' && /timed out/i.test(e.message) && e.statusCode === undefined) {
      e.statusCode = 504
    }
    throw e
  }

  // Solr reports query errors in the body with a 200, so this must be checked explicitly
  // rather than relying on the client to reject.
  if (results && results.error) {
    const err = new Error(`Solr error on ${collection}: ${results.error.msg || JSON.stringify(results.error)}`)
    err.statusCode = results.error.code || 500
    throw err
  }

  return results || {}
}

/**
 * Convenience wrapper returning just the docs array — the shape most callers want.
 * Returns [] rather than undefined when a query matches nothing, so callers can treat the
 * result as an array unconditionally.
 */
async function internalQueryDocs (opts) {
  const results = await internalQuery(opts)
  return (results.response && results.response.docs) || []
}

module.exports = internalQuery
module.exports.internalQuery = internalQuery
module.exports.internalQueryDocs = internalQueryDocs
module.exports.DEFAULT_LIMIT = DEFAULT_LIMIT
module.exports.MAX_LIMIT = MAX_LIMIT
