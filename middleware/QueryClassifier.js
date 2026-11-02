/**
 * QueryClassifier + admission — the two halves of Layer 1.
 *
 * Classifies each query as heavy or interactive, then admits it against the matching
 * pool, queueing briefly rather than rejecting outright. Rationale, measurements and the
 * four properties that matter are in lib/SolrAdmissionControl.js.
 *
 * CLASSIFICATION (from PLAN_SOLR_OVERLOAD_PROTECTION.md Layer 1)
 *
 *   heavy       rows >= 10000, or isDownload, or call_method === 'stream'
 *   interactive everything else
 *
 * These are the amplifiers: a download fans out to ~370 secondary lookups per genome, and
 * a large rows= drives the distributed path's shard fan-out. A single-document get or a
 * 25-row grid page does neither.
 *
 * PLACEMENT (routes/dataType.js) — after Limiter, before APIMethodHandler.
 *
 * After Limiter because Limiter is what normalizes `rows` (capping a 999999999 download
 * request to DOWNLOAD_LIMIT, and a fixed-id query down to idCount+10). Classifying before
 * it would read the client's unbounded number and call almost everything heavy. After
 * JoinResolution so an over-broad join is refused with a 400 without ever occupying a
 * slot — rejecting is cheaper than queueing.
 *
 * WHY THE SLOT IS RELEASED ON RESPONSE FINISH, NOT AFTER THE SOLR CALL
 *
 * The point is to bound concurrent *amplification*, and a streaming download keeps issuing
 * secondary queries for as long as it is writing. Releasing when the primary Solr query
 * returns would let unlimited downloads overlap in their serializer phase, which is
 * precisely the fan-out that caused the June incidents. The slot is therefore held until
 * the response finishes or the connection closes.
 */

const debug = require('debug')('p3api-server:middleware/QueryClassifier')
const Config = require('../config')
const { Pool, AdmissionRejectedError } = require('../lib/SolrAdmissionControl')

const HEAVY_ROWS_THRESHOLD = 10000

// Built once at module load from config. Pool state is per worker, so cluster-facing
// concurrency is pool size x worker count — see the caveat in
// Docs/ADMISSION_CONTROL_STATUS-2026-10.md.
let pools = null

function getConfigured () {
  const cfg = Config.get('queryAdmission') || {}
  return {
    enabled: cfg.enabled === true, // OFF unless explicitly enabled — see below
    heavy: {
      maxConcurrent: cfg.heavyMaxConcurrent === undefined ? 3 : cfg.heavyMaxConcurrent,
      maxQueue: cfg.heavyMaxQueue === undefined ? 6 : cfg.heavyMaxQueue,
      maxWaitMs: cfg.heavyMaxWaitMs === undefined ? 10000 : cfg.heavyMaxWaitMs
    },
    interactive: {
      maxConcurrent: cfg.interactiveMaxConcurrent === undefined ? 20 : cfg.interactiveMaxConcurrent,
      maxQueue: cfg.interactiveMaxQueue === undefined ? 20 : cfg.interactiveMaxQueue,
      maxWaitMs: cfg.interactiveMaxWaitMs === undefined ? 1000 : cfg.interactiveMaxWaitMs
    }
  }
}

function getPools () {
  if (!pools) {
    const cfg = getConfigured()
    pools = {
      enabled: cfg.enabled,
      heavy: new Pool('heavy', cfg.heavy),
      interactive: new Pool('interactive', cfg.interactive)
    }
    debug(`admission ${cfg.enabled ? 'ENABLED' : 'disabled'}: heavy=${cfg.heavy.maxConcurrent}/${cfg.heavy.maxQueue} interactive=${cfg.interactive.maxConcurrent}/${cfg.interactive.maxQueue}`)
  }
  return pools
}

/** Rebuild pools from config. Tests only. */
function resetPools () {
  pools = null
}

/**
 * Heavy or interactive?
 *
 * @param {Object} req
 * @returns {'heavy'|'interactive'}
 */
function classify (req) {
  if (req.isDownload) {
    return 'heavy'
  }
  if (req.call_method === 'stream') {
    return 'heavy'
  }
  const query = req.call_params && req.call_params[0]
  if (typeof query === 'string') {
    const m = query.match(/[&?]rows=(\d+)/)
    if (m && parseInt(m[1], 10) >= HEAVY_ROWS_THRESHOLD) {
      return 'heavy'
    }
  }
  return 'interactive'
}

/** Per-pool snapshot for /stats. */
function getAdmissionStats () {
  const p = getPools()
  return {
    enabled: p.enabled,
    heavy: p.heavy.stats(),
    interactive: p.interactive.stats()
  }
}

module.exports = function QueryClassifier (req, res, next) {
  const p = getPools()

  // Classify regardless, so /stats and the logs are informative even while admission is
  // off. This is also what makes a dry run possible before enabling enforcement.
  req.queryCategory = classify(req)

  if (!p.enabled) {
    return next()
  }
  if (req.call_method !== 'query' && req.call_method !== 'stream') {
    return next()
  }

  const pool = req.queryCategory === 'heavy' ? p.heavy : p.interactive

  pool.acquire({
    // Property 3: a request whose client has already gone is dropped at dequeue rather
    // than admitted. Matches the check media/genbank.js already makes while streaming.
    isAbandoned: () => res.writableEnded || res.destroyed || req.aborted === true
  })
    .then((release) => {
      let released = false
      const releaseOnce = () => {
        if (released) {
          return
        }
        released = true
        release()
      }

      // Hold the slot for the whole response, not just the Solr call — a streaming
      // download amplifies for as long as it is writing. 'close' fires on a normal
      // finish and on a client disconnect alike, so one listener covers both; 'finish'
      // is kept as a belt-and-braces for any path that ends without closing.
      res.once('close', releaseOnce)
      res.once('finish', releaseOnce)

      next()
    })
    .catch((err) => {
      if (err instanceof AdmissionRejectedError) {
        if (err.reason === 'abandoned') {
          // Nobody is listening; end quietly rather than writing a 429 to a dead socket.
          debug('dropped an abandoned queued request')
          if (!res.headersSent) {
            try { res.end() } catch (e) { /* already gone */ }
          }
          return
        }
        console.log(`[Admission] rejected category=${req.queryCategory} reason=${err.reason} pool=${err.pool} rid=${req.requestId || '-'}`)
        if (!res.headersSent) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds))
        }
        return next(err)
      }
      // An unexpected failure in admission must not fail the request: fall through and
      // let it run, as it would have before this middleware existed.
      console.error(`[Admission] unexpected error, admitting anyway: ${err && err.message}`)
      next()
    })
}

module.exports.classify = classify
module.exports.getAdmissionStats = getAdmissionStats
module.exports.resetPools = resetPools
module.exports.HEAVY_ROWS_THRESHOLD = HEAVY_ROWS_THRESHOLD
