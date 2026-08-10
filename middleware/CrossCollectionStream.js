/**
 * CrossCollectionStream Middleware
 *
 * Phase 3b of PLAN_CROSS_COLLECTION_DOWNLOAD.md.
 *
 * When `CrossCollectionSource` has recognized and validated a cross-collection
 * request (`req._crossSource`), this replaces the normal "query the target
 * collection directly" step with the batched source->target resolution stream.
 *
 * It sets `res.results = { stream }` and `req.skipAPIMethodHandler`, the same
 * contract DistributedQuery already uses, so everything downstream — media
 * serializers included — is unchanged. The stream emits ordinary target
 * documents, so protein+fasta, dna+fasta, gff, csv and the rest all work without
 * per-format wiring.
 *
 * Placed after CrossCollectionSource and before checkIfStreaming/APIMethodHandler.
 */

const debug = require('debug')('p3api-server:middleware/CrossCollectionStream')
const Config = require('../config')
const CrossCollectionSourceStream = require('../lib/CrossCollectionSourceStream')

// Lazily-built Solr client, shared across requests (connection pooling).
let directClientPromise = null

/**
 * Build (once) a DirectSolrClient wired with the configured TLS options.
 * Mirrors the setup in middleware/JoinEnrichment.js getJoiner().
 *
 * @returns {Promise<DirectSolrClient>}
 */
function getDirectClient () {
  if (directClientPromise) return directClientPromise

  directClientPromise = (async () => {
    const SolrClusterClient = require('../lib/distributed/SolrClusterClient')
    const DirectSolrClient = require('../lib/distributed/DirectSolrClient')
    const { getConfig: getDistributedConfig } = require('../lib/distributed/DistributedQueryConfig')
    const https = require('https')
    const fs = require('fs')

    const solrUrl = Config.get('solr').url
    const distributedConfig = getDistributedConfig()

    const tlsOptions = {}
    if (distributedConfig.ca) {
      if (distributedConfig.ca.startsWith('/') || distributedConfig.ca.startsWith('./')) {
        try {
          tlsOptions.ca = fs.readFileSync(distributedConfig.ca)
        } catch (err) {
          debug(`Could not read CA file ${distributedConfig.ca}: ${err.message}`)
        }
      } else {
        tlsOptions.ca = distributedConfig.ca
      }
    }
    if (distributedConfig.rejectUnauthorized === false) {
      tlsOptions.rejectUnauthorized = false
    }

    let agent = null
    if (solrUrl.startsWith('https:')) {
      agent = new https.Agent({ keepAlive: true, maxSockets: 10, ...tlsOptions })
    }

    const clusterClient = new SolrClusterClient(solrUrl, { agent })
    return new DirectSolrClient(clusterClient, { agent })
  })()

  return directClientPromise
}

/**
 * Fields a serializer needs on the target document in order to perform its OWN
 * downstream join, keyed by the Accept type it is selected for.
 *
 * The FASTA serializers join genome_feature -> feature_sequence themselves via an
 * md5. If the client's select() does not happen to include that md5 it never
 * reaches the serializer, and the download comes back as correct headers with
 * empty sequence bodies — a plausible-looking, silently broken file.
 *
 * The ordinary request path is protected from this by JoinFieldInjector, which
 * injects join keys into fl= before the query runs. Cross-collection resolution
 * bypasses that (the target fetch is issued by CrossCollectionSourceStream, not
 * by APIMethodHandler), so the same guarantee has to be made here.
 */
const SERIALIZER_REQUIRED_FIELDS = {
  'application/protein+fasta': ['aa_sequence_md5'],
  'application/dna+fasta': ['na_sequence_md5'],
  'application/sralign+dna+fasta': ['na_sequence_md5'],
  // GFF builds each row from these; a narrow select() would blank them out.
  'application/gff': ['accession', 'annotation', 'feature_type', 'start', 'end',
    'strand', 'patric_id', 'refseq_locus_tag', 'product', 'genome_id', 'genome_name'],
  'text/gff3': ['accession', 'annotation', 'feature_type', 'start', 'end',
    'strand', 'patric_id', 'refseq_locus_tag', 'product', 'genome_id', 'genome_name']
}

/**
 * Extract the requested field list from the already-parsed target query, so the
 * target fetch returns the same fields a direct query would — plus whatever the
 * selected serializer needs to complete its own join.
 *
 * @param {Object} req
 * @returns {string|null} Comma-separated fl, or null for "all fields"
 */
function targetFieldList (req) {
  const q = (req.call_params && req.call_params[0]) || ''
  const m = q.match(/[&?]fl=([^&]*)/)
  if (!m) return null

  const fl = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim()
  if (!fl || fl === '*') return null

  const fields = new Set(fl.split(',').map((f) => f.trim()).filter(Boolean))

  const accept = (req.headers && req.headers.accept) || ''
  const required = SERIALIZER_REQUIRED_FIELDS[accept] || []
  for (const f of required) {
    if (!fields.has(f)) {
      fields.add(f)
      debug(`Injecting '${f}' into target fl for ${accept}`)
    }
  }

  return Array.from(fields).join(',')
}

function crossCollectionStreamMiddleware (req, res, next) {
  const spec = req._crossSource
  if (!spec) {
    return next()
  }

  // Only downloads/streams go through resolution. A paginated cross-collection
  // read is a different feature (the linked join covers it) and silently
  // rewriting a normal query here would be surprising.
  if (req.call_method !== 'stream') {
    debug(`Cross-collection source set but call_method=${req.call_method}; not resolving`)
    return next()
  }

  getDirectClient().then((client) => {
    const stream = new CrossCollectionSourceStream({
      solrClient: client,
      sourceCollection: spec.collection,
      targetCollection: spec.target,
      linkField: spec.linkField,
      targetKeyField: spec.linkField,
      sourceQ: spec.sourceQ,
      sourceFq: spec.sourceFq,
      sourcePermissionFq: spec.permissionFq,
      targetFl: targetFieldList(req),
      batchSize: spec.batchSize,
      ctx: spec.ctx
    })

    // Stop resolving if the client hangs up mid-download; otherwise the cursor
    // keeps paging Solr for a response nobody is reading.
    const onClose = () => {
      if (!stream.destroyed) {
        debug('Client disconnected; destroying source stream')
        stream.destroy()
      }
    }
    res.on('close', onClose)

    stream.on('end', () => {
      res.removeListener('close', onClose)

      const stats = stream.getStats()

      // Counts are only known once resolution finishes, and a streaming download
      // has already flushed headers by then (the first res.write commits them).
      // So in practice these headers land only on responses that produced no
      // body at all — which is, usefully, exactly the empty-download case.
      //
      // This is a real limitation of the plan's original design, not an
      // oversight here: the counts cannot be both accurate and in the headers of
      // a streamed response. Computing them upfront would mean resolving the
      // whole source set before writing a byte, which is the unbounded-memory
      // behavior this feature exists to avoid.
      //
      // The user-visible path for the count is therefore the SSE side channel
      // (PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md) — which is required anyway, since a
      // hidden-form POST download cannot read response headers under any
      // circumstances. res.locals below is what that publisher reads.
      if (!res.headersSent) {
        res.set('X-Source-Rows', String(stats.sourceRows))
        res.set('X-Resolved', String(stats.linkValues))
        res.set('X-Result-Count', String(stats.targetDocs))
      } else {
        debug(`headers already sent; counts available only via res.locals/SSE: ` +
              `sourceRows=${stats.sourceRows} resolved=${stats.linkValues} ` +
              `written=${stats.targetDocs}`)
      }

      // Expose the counts for the SSE publisher / access log regardless.
      res.locals = res.locals || {}
      res.locals.crossSourceStats = stats

      if (stats.targetDocs === 0) {
        // The empty-download case BUG2 is about. Log it server-side so it is
        // diagnosable even when the client cannot see the headers.
        console.warn(
          `[CrossCollectionDownload] empty result: ${spec.collection}.${spec.linkField} ` +
          `-> ${spec.target} user=${spec.ctx.user || 'anonymous'} ` +
          `sourceRows=${stats.sourceRows} resolved=${stats.linkValues}`)
      } else if (stats.sourceRows > 0 && stats.linkValues < stats.sourceRows) {
        debug(`shortfall: ${stats.sourceRows} source rows -> ${stats.linkValues} link values ` +
              `(${stats.duplicatesSkipped} duplicates)`)
      }
    })

    res.results = { stream }
    req.skipAPIMethodHandler = true
    req._crossSourceStream = stream

    debug(`Resolving ${spec.collection}.${spec.linkField} -> ${spec.target} ` +
          `(batchSize=${spec.batchSize})`)

    next()
  }).catch((err) => {
    // Fail before any body bytes rather than emitting a truncated download.
    console.error(`CrossCollectionStream setup failed: ${err.message}`)
    res.status(500).json({
      status: 500,
      message: `Unable to resolve cross-collection source: ${err.message}`
    })
  })
}

module.exports = crossCollectionStreamMiddleware
module.exports.targetFieldList = targetFieldList
