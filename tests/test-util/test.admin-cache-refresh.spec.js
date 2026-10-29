/**
 * /admin/cache/refresh — recompute and overwrite, never deleting.
 *
 * THE PROPERTY THAT MATTERS: the cache key is never absent. Every test here defends it.
 *
 * Why it matters. apicache does NO request coalescing — no inflight/pending/lock exists
 * in the module — so every concurrent miss on a key runs the handler independently.
 * Deleting a key before refilling therefore opens a hole lasting the WHOLE fill, during
 * which each arriving request starts its own full recomputation of the same answer.
 * Measured: taxon 10239 takes 1967.8s (32.8 min), taxon 11646 56.0s. That is half an
 * hour of the busiest summary endpoint uncached, with a thundering herd of 33-minute
 * facet walks into a heavy admission pool of 3 slots per worker — strictly worse than
 * doing nothing, because today an expired entry costs the next user exactly one fill.
 *
 * Offline: a stub Redis and a stub upstream, both local. No API, no real Redis, no Solr.
 */

const assert = require('chai').assert
const http = require('http')
const express = require('express')
const Config = require('../../config')

const TOKEN = 'refresh-test-token'

/** Minimal in-memory stand-in for the subset of node_redis this router uses. */
function stubRedis () {
  const hashes = new Map()
  const ttls = new Map()
  return {
    connected: true,
    log: [],
    hset (key, field, value, cb) {
      this.log.push(['hset', key, field])
      if (!hashes.has(key)) hashes.set(key, {})
      hashes.get(key)[field] = value
      if (cb) cb(null, 1)
    },
    expire (key, seconds, cb) {
      this.log.push(['expire', key, seconds])
      ttls.set(key, seconds)
      if (cb) cb(null, 1)
    },
    del (key, cb) {
      this.log.push(['del', key])
      const had = hashes.delete(key)
      ttls.delete(key)
      if (cb) cb(null, had ? 1 : 0)
    },
    ttl (key, cb) { cb(null, ttls.has(key) ? ttls.get(key) : -2) },
    on () {},
    _get: (k) => hashes.get(k),
    _ttl: (k) => ttls.get(k)
  }
}

describe('admin cache refresh', function () {
  let savedAdmin, savedPort, upstream, upstreamPort
  let upstreamStatus = 200
  let upstreamBody = '{"CDS":123}'
  let upstreamSawBypass = null
  let upstreamHits = 0

  before(function (done) {
    // Stands in for the public /data route the refresh fetches over loopback.
    upstream = http.createServer((req, res) => {
      upstreamHits++
      upstreamSawBypass = req.headers['x-apicache-bypass'] || null
      res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
      res.end(upstreamBody)
    })
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port
      done()
    })
  })

  after(function (done) { upstream.close(done) })

  beforeEach(function () {
    savedAdmin = Config.get('admin')
    savedPort = Config.get('http_port')
    Config.set('admin', { enabled: true, token: TOKEN })
    // Point the router's loopback self-fetch at the stub upstream.
    Config.set('http_port', upstreamPort)
    upstreamStatus = 200
    upstreamBody = '{"CDS":123}'
    upstreamHits = 0
    upstreamSawBypass = null
  })

  afterEach(function () {
    Config.set('admin', savedAdmin)
    Config.set('http_port', savedPort)
  })

  /** Mount the router with its redis swapped for a stub, and call it over a real socket. */
  function withRouter (redisStub, fn) {
    delete require.cache[require.resolve('../../routes/adminRouter')]
    const Module = require('module')
    const orig = Module.prototype.require
    Module.prototype.require = function (id) {
      if (id === 'redis') return { createClient: () => redisStub }
      return orig.apply(this, arguments)
    }
    const router = require('../../routes/adminRouter')
    Module.prototype.require = orig

    const app = express()
    app.use('/admin', router)
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', async () => {
        try {
          const out = await fn(srv.address().port)
          srv.close(() => resolve(out))
        } catch (e) { srv.close(() => reject(e)) }
      })
    })
  }

  const call = (port, path, method = 'POST') => new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'X-Admin-Token': TOKEN } },
      (res) => {
        let b = ''
        res.on('data', (d) => { b += d })
        res.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(b) } catch (e) { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, raw: b })
        })
      })
    req.on('error', (e) => resolve({ status: 0, raw: e.message }))
    req.end()
  })

  it('NEVER deletes the key — the whole point', async function () {
    const r = stubRedis()
    await withRouter(r, async (port) => {
      const out = await call(port, '/admin/cache/refresh/summary_by_taxon/10239')
      assert.equal(out.status, 200)
      assert.isTrue(out.body.refreshed)
    })
    const dels = r.log.filter((e) => e[0] === 'del')
    assert.lengthOf(dels, 0, 'a DEL opens a 33-minute hole with no request coalescing')
  })

  it('writes the value and a full TTL under the clean public key', async function () {
    const r = stubRedis()
    await withRouter(r, (port) => call(port, '/admin/cache/refresh/summary_by_taxon/10239'))
    const key = '/data/summary_by_taxon/10239'
    assert.isOk(r._get(key), 'must write the key the public route reads')
    assert.equal(r._ttl(key), 86400)
    const stored = JSON.parse(r._get(key).response)
    assert.equal(stored.status, 200)
    assert.equal(stored.data, '{"CDS":123}')
    assert.isNumber(stored.timestamp, 'sendCachedResponse decrements max-age from this')
    assert.property(stored, 'headers')
    // `encoding` is deliberately absent rather than present-and-null. JSON.stringify
    // drops an undefined value, and the read path does `response.end(data,
    // cacheObject.encoding)` (apicache.js:288) — end(string, undefined) is exactly
    // Node's default, so an omitted field round-trips correctly. Asserting it exists
    // would pin a shape apicache does not require.
    assert.isUndefined(stored.encoding)
  })

  it('bypasses the cache on its own fetch, so it recomputes rather than reading back', async function () {
    const r = stubRedis()
    await withRouter(r, (port) => call(port, '/admin/cache/refresh/summary_by_taxon/10239'))
    assert.equal(upstreamSawBypass, '1')
    assert.equal(upstreamHits, 1)
  })

  describe('a failed refresh must leave the previous value intact', function () {
    it('does not write or delete when upstream returns non-200', async function () {
      const r = stubRedis()
      upstreamStatus = 500
      const out = await withRouter(r, (port) =>
        call(port, '/admin/cache/refresh/summary_by_taxon/10239'))
      assert.equal(out.status, 502)
      assert.isFalse(out.body.refreshed)
      assert.lengthOf(r.log.filter((e) => e[0] === 'del'), 0)
      assert.lengthOf(r.log.filter((e) => e[0] === 'hset'), 0,
        'a 500 body must not replace a good cached value')
    })

    it('reports 503 and touches nothing when redis is down', async function () {
      const r = stubRedis()
      r.connected = false
      const out = await withRouter(r, (port) =>
        call(port, '/admin/cache/refresh/summary_by_taxon/10239'))
      assert.equal(out.status, 503)
      assert.lengthOf(r.log, 0)
    })
  })

  describe('the endpoint names an operation, not a path', function () {
    // An earlier draft took /cache/refresh/* and self-fetched whatever path the caller
    // gave, which is a request-forgery primitive — it would fetch any loopback route,
    // /admin included, and store the result under a caller-chosen key.
    it('rejects an unknown resource', async function () {
      const r = stubRedis()
      const out = await withRouter(r, (port) => call(port, '/admin/cache/refresh/etc_passwd/1'))
      assert.equal(out.status, 404)
      assert.deepEqual(out.body.known, ['summary_by_taxon'])
      assert.equal(upstreamHits, 0, 'must not fetch anything')
    })

    it('rejects a non-numeric taxon id', async function () {
      const r = stubRedis()
      for (const bad of ['abc', '../../admin/ping', '1;DROP', '%2e%2e']) {
        const out = await withRouter(r, (port) =>
          call(port, `/admin/cache/refresh/summary_by_taxon/${encodeURIComponent(bad)}`))
        assert.oneOf(out.status, [400, 404], `must reject id ${bad}`)
      }
      assert.equal(upstreamHits, 0)
    })

    it('does not let a path escape into the cache key', async function () {
      const r = stubRedis()
      await withRouter(r, (port) =>
        call(port, '/admin/cache/refresh/summary_by_taxon/10239%2F..%2Fadmin%2Fping'))
      assert.lengthOf(r.log.filter((e) => e[0] === 'hset'), 0)
    })
  })

  describe('ttl reporting', function () {
    it('reports an absent key as not cached', async function () {
      const r = stubRedis()
      const out = await withRouter(r, (port) =>
        call(port, '/admin/cache/ttl/summary_by_taxon/999', 'GET'))
      assert.equal(out.status, 200)
      assert.isFalse(out.body.cached)
    })

    it('reports a fresh TTL after a refresh — how a warmer tells a fill from a hit', async function () {
      const r = stubRedis()
      await withRouter(r, (port) => call(port, '/admin/cache/refresh/summary_by_taxon/10239'))
      const out = await withRouter(r, (port) =>
        call(port, '/admin/cache/ttl/summary_by_taxon/10239', 'GET'))
      assert.isTrue(out.body.cached)
      assert.equal(out.body.ttlSeconds, 86400)
    })
  })
})
