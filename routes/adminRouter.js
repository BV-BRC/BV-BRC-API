/**
 * /admin — local-only operational endpoints. See PLAN_ADMIN_ENDPOINT.md.
 *
 * Authorization is middleware/adminGate.js (loopback peer + X-Admin-Token). Every route
 * here is behind it; nothing in this file re-checks.
 *
 * REFRESH WITHOUT EVER DELETING — compute first, then overwrite
 *
 * The obvious implementation is invalidate-then-fetch: DEL the key, then GET the public
 * URL so the miss refills it. **That is a regression and this endpoint does not do it.**
 *
 * `apicache` does NO request coalescing — there is no inflight/pending/lock anywhere in
 * the module — so every concurrent miss on a key runs the handler independently. Deleting
 * the key therefore opens a hole lasting the ENTIRE fill, during which every arriving
 * request starts its own full recomputation of the same answer:
 *
 *     taxon 10239   1967.8 s   (32.8 minutes)
 *     taxon 11646     56.0 s
 *
 * Half an hour of the most-visited summary endpoint uncached, with each visitor kicking
 * off another 33-minute sliced-facet walk into a heavy admission pool of 3 slots per
 * worker. And it is strictly worse than doing nothing: today an expired entry costs the
 * *next* user one fill, whereas invalidate-first opens that hole deliberately and widens
 * it, because the warmer's own fetch now competes with the users it displaced.
 *
 * It also fails badly. If the fill errors — taxon 11118's 524, or any Solr blip — the key
 * is already gone, so a broken warmer actively destroys a good cached value.
 *
 * So: fetch with `X-Apicache-Bypass`, which apicache honours at :602 by skipping the
 * cache entirely (neither reading nor writing), then write the result under the clean key
 * ourselves. The old value serves every user throughout and is replaced in one step; a
 * failed fill leaves it untouched.
 *
 *   POST http://127.0.0.1:13001/admin/cache/refresh/summary_by_taxon/10239
 *
 * The endpoint names an OPERATION and its parameter, not a path — see REFRESHABLE below
 * for why taking a caller-supplied path would be a request-forgery primitive.
 *
 * Writing by hand is safe because the stored shape is small, stable, and fully specified
 * by `createCacheObject` (apicache.js:122-130) — `{status, headers, data, encoding,
 * timestamp}` in a Redis hash field `response`, with a sibling `duration` field and a key
 * TTL. `sendCachedResponse` reads exactly those back. buildCacheObject() below mirrors it,
 * and tests/test-util/test.admin-cache-refresh.spec.js pins the contract so an apicache
 * upgrade that changes the shape fails loudly rather than silently serving corrupt
 * entries.
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
const http = require('http')
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

/**
 * Build the client options.
 *
 * Redis requires auth in the deployed environments. node_redis 2.8 reads the password
 * from `options.auth_pass || options.password` (redis/index.js:149), so the deployed
 * config's `password` key already works and is passed through untouched — this function
 * exists for the other spellings, not that one.
 *
 * The deployed block carries BOTH `pass` and `password` with the same value. Only
 * `password` is honoured; `pass` is inert. Some configs instead use `xpass`/`xpassword`,
 * where the `x` prefix marks a key as deliberately disabled. Accepting all of them means
 * /admin works against whichever variant a host happens to have, rather than failing
 * NOAUTH in a way that is very hard to read from a cron report.
 *
 * `routes/dataRouter.js` passes the raw config block straight to apicache and relies on
 * `password` being the live key; that works today and is not this file's to change.
 */
function redisOptions () {
  const cfg = Object.assign({}, Config.get('redis') || {})
  const pass = cfg.auth_pass || cfg.password || cfg.pass || cfg.xpass || cfg.xpassword
  if (pass) {
    cfg.auth_pass = pass
  }
  // Drop the spellings node_redis does not read. It ignores unknown keys, but leaving an
  // inert `xpass` next to a live `auth_pass` invites someone to "tidy" the wrong one.
  delete cfg.pass
  delete cfg.xpass
  delete cfg.xpassword
  return cfg
}

function getRedis () {
  if (!redisClient) {
    redisClient = redis.createClient(redisOptions())
    redisClient.on('error', (err) => {
      // Log once per client rather than per retry; the handler below reports the failure
      // to the caller, which is the signal that matters.
      if (!redisErrLogged) {
        redisErrLogged = true
        console.error(`[ADMIN] redis error: ${err && err.message}`)
      }
    })
    redisClient.on('ready', () => { redisErrLogged = false })
  }
  return redisClient
}

router.use(adminGate)

// Mirrors apicache's createCacheObject (apicache.js:122-130). The shape is the contract
// between this endpoint and apicache's sendCachedResponse; if an apicache upgrade changes
// it, tests/test-util/test.admin-cache-refresh.spec.js fails rather than this silently
// writing entries that deserialize wrong.
//
// `timestamp` is seconds since epoch and is load-bearing: sendCachedResponse uses it to
// decrement the max-age header it returns to clients.
function buildCacheObject (status, headers, body) {
  return {
    status,
    headers,
    data: body,
    encoding: undefined,
    timestamp: new Date().getTime() / 1000
  }
}

/**
 * Named refreshable resources.
 *
 * The endpoint takes an OPERATION plus its parameter, not a path. An earlier draft of
 * this took `/cache/refresh/*` and self-fetched whatever path the caller supplied, which
 * is a request-forgery primitive: it would happily fetch any route on the loopback
 * listener, `/admin/*` included, and write the result into a cache key of the caller's
 * choosing. Gated or not, that is the wrong shape to build.
 *
 * Adding a resource here is deliberate work: supply the key template and validate the
 * parameter. Both are required — the key must match what the public route's apicache saw
 * (`req.originalUrl`), or the refresh writes somewhere nothing reads.
 */
const REFRESHABLE = {
  summary_by_taxon: {
    // Must match routes/dataRouter.js's mount exactly: /data + /summary_by_taxon/:taxon_id
    key: (id) => `/data/summary_by_taxon/${id}`,
    // Taxon ids are integers. Anything else cannot reach path construction.
    valid: (id) => /^\d{1,12}$/.test(id)
  }
}

/**
 * Recompute one named cached resource and overwrite it, never leaving the key absent.
 *
 *   POST /admin/cache/refresh/summary_by_taxon/10239
 *
 * See the header for why this does not DEL first.
 */
router.post('/cache/refresh/:resource/:id', function (req, res) {
  const spec = REFRESHABLE[req.params.resource]
  if (!spec) {
    return res.status(404).json({
      error: `Unknown refreshable resource '${req.params.resource}'`,
      known: Object.keys(REFRESHABLE)
    })
  }
  if (!spec.valid(req.params.id)) {
    return res.status(400).json({ error: `Invalid id for ${req.params.resource}` })
  }
  const key = spec.key(req.params.id)

  // No `client.connected` precheck. createClient() connects ASYNCHRONOUSLY, so
  // `connected` is false for a few milliseconds after the lazy client is built and the
  // FIRST admin request on each worker would always 503 -- observed on alpha, where the
  // first taxa of a run failed on every worker in turn. node_redis 2.x queues commands
  // until the connection is ready (enable_offline_queue, on by default), so issuing the
  // command directly is both correct and simpler; a genuinely dead Redis surfaces as a
  // command error below rather than as a guess made before connecting.
  const client = getRedis()

  // Default to apicache's configured duration for these routes (1 day). Overridable so a
  // caller can shorten a refresh it knows is provisional.
  const durationMs = parseInt(req.query.duration_ms, 10) > 0
    ? parseInt(req.query.duration_ms, 10)
    : 24 * 60 * 60 * 1000

  // Fetch over loopback with the bypass header, so this request neither reads the cache
  // (we want a real recomputation) nor writes it (we write it ourselves, atomically).
  const started = Date.now()
  const opts = {
    host: '127.0.0.1',
    port: Config.get('http_port'),
    path: key,
    method: 'GET',
    headers: {
      'X-Apicache-Bypass': '1',
      'User-Agent': 'bvbrc-api/admin-refresh'
    }
  }

  const upstream = http.request(opts, (r) => {
    const chunks = []
    r.on('data', (c) => chunks.push(c))
    r.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const elapsedMs = Date.now() - started

      // Only a 200 may replace a good cached value. This matches apicache's own
      // onlyStatus200 toggle on these routes, and it is what makes a failed refresh
      // harmless: the previous entry is still there, untouched.
      if (r.statusCode !== 200) {
        console.error(`[ADMIN] cache refresh ${key} upstream ${r.statusCode} after ${elapsedMs}ms — cache left intact`)
        return res.status(502).json({
          key,
          refreshed: false,
          upstreamStatus: r.statusCode,
          elapsedMs,
          note: 'Previous cached value left intact'
        })
      }

      const value = buildCacheObject(200, { 'content-type': r.headers['content-type'] || 'application/json' }, body)
      // hset + expire, exactly as apicache's cacheResponse does. The key never went
      // away, so readers saw the old value right up to this write.
      client.hset(key, 'response', JSON.stringify(value), (e1) => {
        if (e1) {
          // Surface the real reason. A NOAUTH here means the password is missing or
          // under a key redisOptions() does not recognise, which is otherwise a very
          // confusing failure to diagnose from the warmer's output.
          console.error(`[ADMIN] cache refresh ${key}: redis HSET failed: ${e1.message}`)
          return res.status(503).json({ key, refreshed: false, error: `Redis write failed: ${e1.message}` })
        }
        client.hset(key, 'duration', durationMs, () => {
          client.expire(key, durationMs / 1000, () => {
            console.log(`[ADMIN] cache refresh key=${key} bytes=${body.length} elapsed=${elapsedMs}ms ttl=${durationMs / 1000}s`)
            res.json({ key, refreshed: true, bytes: body.length, elapsedMs, ttlSeconds: durationMs / 1000 })
          })
        })
      })
    })
  })

  // No timeout is set deliberately: a legitimate refresh of taxon 10239 measured 32.8
  // minutes, and cutting it short would be the one thing this endpoint exists to avoid.
  // The caller (cron) owns the deadline.
  upstream.on('error', (err) => {
    console.error(`[ADMIN] cache refresh ${key} failed: ${err && err.message} — cache left intact`)
    res.status(502).json({ key, refreshed: false, error: err && err.message, note: 'Previous cached value left intact' })
  })
  upstream.end()
})

/**
 * Report whether a key is cached and how long it has left.
 *
 * The reason this exists: a warmer cannot otherwise tell a fill from a cache hit, which
 * is exactly how the nightly run came to report "done in 4 min, 0 failures" while
 * refilling nothing. A TTL near the full duration means freshly written.
 */
router.get('/cache/ttl/:resource/:id', function (req, res) {
  const spec = REFRESHABLE[req.params.resource]
  if (!spec) {
    return res.status(404).json({
      error: `Unknown resource '${req.params.resource}'`,
      known: Object.keys(REFRESHABLE)
    })
  }
  if (!spec.valid(req.params.id)) {
    return res.status(400).json({ error: `Invalid id for ${req.params.resource}` })
  }
  const key = spec.key(req.params.id)

  // No `client.connected` precheck. createClient() connects ASYNCHRONOUSLY, so
  // `connected` is false for a few milliseconds after the lazy client is built and the
  // FIRST admin request on each worker would always 503 -- observed on alpha, where the
  // first taxa of a run failed on every worker in turn. node_redis 2.x queues commands
  // until the connection is ready (enable_offline_queue, on by default), so issuing the
  // command directly is both correct and simpler; a genuinely dead Redis surfaces as a
  // command error below rather than as a guess made before connecting.
  const client = getRedis()

  client.ttl(key, (err, ttl) => {
    if (err) {
      console.error(`[ADMIN] cache ttl ${key}: ${err.message}`)
      return res.status(503).json({ error: `Redis TTL failed: ${err.message}`, key })
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
// Exported for testing: the password-spelling handling is easy to get wrong and hard to
// diagnose from a cron report, so it is pinned directly.
module.exports.redisOptions = redisOptions
