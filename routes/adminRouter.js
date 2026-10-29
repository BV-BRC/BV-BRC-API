/**
 * /admin — local-only operational endpoints. See PLAN_ADMIN_ENDPOINT.md.
 *
 * Authorization is middleware/adminGate.js (loopback peer + X-Admin-Token). Every route
 * here is behind it; nothing in this file re-checks.
 *
 * WHY INVALIDATE RATHER THAN REFILL
 *
 * The obvious operation is "refresh this cache entry," and that is not what this
 * provides. `apicache` exposes no public API for WRITING an entry — `cacheResponse` is
 * internal, and an entry is only ever stored by a real request passing through the cache
 * middleware (apicache.js:132-145). So a server-side "refill" would have to either
 * reimplement the handler chain or self-call our own port, and
 * PLAN_ELIMINATE_SELF_CALL.md is a long account of why the second is a bad idea.
 *
 * Invalidate-then-fetch gives the same result with none of that:
 *
 *   POST http://127.0.0.1:13001/admin/cache/invalidate/data/summary_by_taxon/10239
 *   GET  http://127.0.0.1:13001/data/summary_by_taxon/10239
 *
 * The GET misses, runs the real handler chain, and apicache stores the result under the
 * clean key with a full fresh TTL — because every apicache write reissues `hset` +
 * `expire` together (apicache.js:138-140).
 *
 * Fetching over loopback has a second payoff: it does not traverse Cloudflare, whose
 * ~125 s silence budget is what makes taxon 11118 (9,468,441 genomes) impossible to warm
 * through the public URL today — it 524s on alpha *and* production.
 *
 * WHY NOT ?refresh=1 ON THE PUBLIC ROUTE
 *
 * apicache keys on `req.originalUrl` VERBATIM (apicache.js:620, `appendKey: []`). Any
 * added parameter writes a DIFFERENT entry, so a refresh flag would spend ~56 s warming
 * a cache nobody reads.
 */

const express = require('express')
const debug = require('debug')('p3api-server:route/admin')
const Config = require('../config')
const redis = require('redis')
const adminGate = require('../middleware/adminGate')

const router = express.Router()

// Same Redis database apicache writes to; routes/dataRouter.js builds its cache from
// `config.redis` and so must this, or we would delete keys in the wrong db and report
// success while changing nothing.
//
// Created LAZILY. At module load `admin.enabled` is usually false, and an eager client
// against an absent Redis reconnects forever — observed emitting an ECONNREFUSED line
// per retry, indefinitely, in an environment that was never going to use /admin. Nothing
// here should cost anything until an admin route is actually called.
let redisClient = null
let redisErrLogged = false

function getRedis () {
  if (!redisClient) {
    redisClient = redis.createClient(Config.get('redis'))
    redisClient.on('error', (err) => {
      // Log once per client rather than per retry; the handler below reports the failure
      // to the caller, which is the signal that matters.
      if (!redisErrLogged) {
        redisErrLogged = true
        console.error(`[ADMIN] redis error: ${err && err.message}`)
      }
    })
  }
  return redisClient
}

router.use(adminGate)

/**
 * Invalidate one cached entry.
 *
 *   POST /admin/cache/invalidate/<the exact path apicache keyed on>
 *
 * The key is the request's `originalUrl` as the public route saw it, so the caller
 * supplies that path verbatim after the prefix. Deliberately NOT a pattern or a wildcard:
 * this endpoint can force expensive recomputation, and "invalidate everything matching *"
 * is an amplifier waiting to be misused.
 */
router.post('/cache/invalidate/*', function (req, res) {
  // Everything after the prefix is the cached path. Leading slash restored because
  // apicache stores `req.originalUrl`, which always has one.
  const suffix = req.params[0] || ''
  const key = '/' + suffix.replace(/^\/+/, '')

  const client = getRedis()
  if (!client.connected) {
    return res.status(503).json({ error: 'Redis is not connected', key })
  }

  client.del(key, (err, removed) => {
    if (err) {
      console.error(`[ADMIN] cache invalidate failed for ${key}: ${err.message}`)
      return res.status(500).json({ error: 'Redis DEL failed', key })
    }
    // `removed` is 0 when the key was absent — already expired, or never cached. That is
    // a successful no-op, not an error: the caller's goal is "this key is not cached",
    // which now holds either way. Reported distinctly so a warmer can tell the
    // difference between "I expired a live entry" and "there was nothing there."
    console.log(`[ADMIN] cache invalidate key=${key} removed=${removed}`)
    res.json({ key, removed: removed > 0 })
  })
})

/**
 * Report whether a key is cached and how long it has left.
 *
 * The reason this exists: a warmer cannot otherwise tell a fill from a cache hit, which
 * is exactly how the nightly run came to report "done in 4 min, 0 failures" while
 * refilling nothing. A TTL near the full duration means freshly written.
 */
router.get('/cache/ttl/*', function (req, res) {
  const suffix = req.params[0] || ''
  const key = '/' + suffix.replace(/^\/+/, '')

  const client = getRedis()
  if (!client.connected) {
    return res.status(503).json({ error: 'Redis is not connected', key })
  }

  client.ttl(key, (err, ttl) => {
    if (err) {
      return res.status(500).json({ error: 'Redis TTL failed', key })
    }
    // Redis TTL: -2 absent, -1 present but no expiry.
    res.json({
      key,
      cached: ttl !== -2,
      ttlSeconds: ttl >= 0 ? ttl : null,
      noExpiry: ttl === -1
    })
  })
})

/** Liveness for the admin surface itself, so a caller can verify the gate without side effects. */
router.get('/ping', function (req, res) {
  debug('admin ping')
  res.json({ ok: true, pid: process.pid })
})

module.exports = router
