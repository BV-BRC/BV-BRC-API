/**
 * CrossCollectionSource Middleware
 *
 * Phase 1 of PLAN_CROSS_COLLECTION_DOWNLOAD.md — the security boundary.
 *
 * A cross-collection download POSTs to the TARGET collection (e.g. genome_feature)
 * while the RQL body describes a query against a different SOURCE collection
 * (e.g. the sp_gene grid filter). This middleware recognizes that shape, validates
 * it against a server-side allowlist, permission-scopes the source query, and
 * records the result on `req._crossSource` for the download pipeline (Phase 3).
 *
 * It does NOT execute anything. When the source params are absent — the
 * overwhelming majority of requests — it is a no-op and behavior is identical to
 * today.
 *
 * Two properties this middleware is responsible for:
 *
 *   1. The (source, linkField, target) triple is allowlisted. Clients name a
 *      pair of collections; without an allowlist that is an arbitrary
 *      read-any-collection primitive. Same trust boundary as SolrQuerySanitizer.
 *   2. The SOURCE query is permission-scoped. The normal chain (DecorateQuery)
 *      scopes the TARGET query only — it has no idea a second collection is
 *      involved. An unscoped source cursor would read another user's private
 *      sp_gene rows into a download, which is an IDOR.
 */

const debug = require('debug')('p3api-server:middleware/CrossCollectionSource')
const Config = require('../config')
const { buildPermissionFq } = require('../lib/permissionFilter')

/**
 * Default allowlist of (sourceCollection, linkField, targetCollection) triples.
 *
 * Verified 2026-08-06 against the website's authoritative client-side map,
 * `../bvbrc_website/public/js/p3/util/DownloadFormats.js` `formatOverrides`
 * (genome: lines 220-224, sp_gene: lines 264-265).
 *
 * Note `genome -> genome_feature` covers both the FASTA formats and `gff`; the
 * source resolution is format-independent, so the triple is listed once.
 * `genome_feature -> genome_feature` is deliberately NOT here: a genome_feature
 * grid downloading sequences is same-collection and never takes this path.
 *
 * Override via `crossCollectionDownload.allowedSources` in p3api.conf.
 */
const DEFAULT_ALLOWED_SOURCES = [
  { source: 'sp_gene', linkField: 'feature_id', target: 'genome_feature' },
  { source: 'genome', linkField: 'genome_id', target: 'genome_feature' },
  { source: 'genome', linkField: 'genome_id', target: 'genome_sequence' }
]

/**
 * Load the cross-collection download config.
 *
 * @returns {Object} { enabled, allowedSources, batchSize }
 */
function getConfig () {
  const configured = Config.get('crossCollectionDownload') || {}
  const distributed = Config.get('distributedQuery') || {}

  return {
    enabled: configured.enabled !== false,
    allowedSources: configured.allowedSources || DEFAULT_ALLOWED_SOURCES,
    // Defaults to the shard cursor batch size; overridable if the source cursor
    // wants to diverge from it (plan §Edge cases).
    batchSize: configured.batchSize || distributed.cursorBatchSize || 2000
  }
}

/**
 * Check a (source, linkField, target) triple against the allowlist.
 *
 * @param {Array<Object>} allowedSources - Allowlist entries
 * @param {string} source - Source collection
 * @param {string} linkField - Field on source linking to target
 * @param {string} target - Target (URL) collection
 * @returns {boolean} True if the triple is permitted
 */
function isAllowed (allowedSources, source, linkField, target) {
  return allowedSources.some((e) =>
    e.source === source && e.linkField === linkField && e.target === target)
}

/**
 * Reject with a 400 in the same JSON shape as the GenBank collection guard.
 *
 * @param {Object} res - Express response
 * @param {string} message - Client-facing message
 */
function reject (res, message) {
  debug(`Rejecting cross-collection request: ${message}`)
  return res.status(400).json({ status: 400, message })
}

/**
 * CrossCollectionSource Middleware
 *
 * Place after Limiter, before JoinFieldInjector / checkIfStreaming.
 */
function crossCollectionSourceMiddleware (req, res, next) {
  const params = req.sourceParams
  if (!params) {
    return next()
  }

  const sourceCollection = params.http_source_collection
  const linkField = params.http_source_link_field

  // Neither present — normal request, nothing to do.
  if (!sourceCollection && !linkField) {
    return next()
  }

  // One without the other is a malformed request, not a normal one. Fail loudly
  // rather than silently ignoring half a cross-collection instruction and
  // running the source filter against the target collection.
  if (!sourceCollection || !linkField) {
    return reject(res,
      'Cross-collection download requires both http_source_collection and http_source_link_field')
  }

  const config = getConfig()
  if (!config.enabled) {
    return reject(res, 'Cross-collection downloads are not enabled on this server')
  }

  const targetCollection = req.call_collection
  if (!targetCollection) {
    return reject(res, 'Cross-collection download requires a target collection')
  }

  if (!isAllowed(config.allowedSources, sourceCollection, linkField, targetCollection)) {
    // Deliberately explicit: an allowlist miss is a client bug (or an attack),
    // and a silent empty file is exactly the failure mode this plan exists to
    // remove. Name the triple so the client can fix its mapping table.
    return reject(res,
      `Unsupported cross-collection download: ${sourceCollection}.${linkField} -> ${targetCollection}`)
  }

  // The RQL body is the SOURCE query. The normal chain has already parsed it
  // against the TARGET collection (RQLQueryParser), which is wrong for our
  // purposes — field names and any collection-scoped rewriting belong to the
  // source. Keep the raw body so Phase 3 can re-parse it against the source.
  const rawSourceQuery = typeof req._rawBody === 'string' ? req._rawBody : ''

  // Permission-scope the SOURCE. DecorateQuery scoped the target; nothing in the
  // chain knows about this second collection. Without this the source cursor
  // reads rows the user cannot see.
  const permissionFq = buildPermissionFq({
    collection: sourceCollection,
    user: req.user,
    publicFree: req.publicFree
  })

  req._crossSource = {
    collection: sourceCollection,
    linkField,
    target: targetCollection,
    rawQuery: rawSourceQuery,
    permissionFq,
    batchSize: config.batchSize,
    // Same ctx shape enrichDocs/enrichDocsChained take, so the target and
    // sequence hops are scoped by the existing permission-aware machinery.
    ctx: { user: req.user, publicFree: req.publicFree }
  }

  debug(`Cross-collection source: ${sourceCollection}.${linkField} -> ${targetCollection} ` +
        `(user=${req.user || 'anonymous'}, permissionFq=${permissionFq || 'none'})`)

  next()
}

module.exports = crossCollectionSourceMiddleware
module.exports.getConfig = getConfig
module.exports.isAllowed = isAllowed
module.exports.DEFAULT_ALLOWED_SOURCES = DEFAULT_ALLOWED_SOURCES
