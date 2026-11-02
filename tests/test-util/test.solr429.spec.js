/**
 * Solr 429 handling.
 *
 * The defect these cover: every Solr client collapsed a non-2xx response into a bare
 * Error, discarding the status, and ShardCursorStream's retry loop treated any rejection
 * as retriable. A 429 — "I am overloaded, stop sending" — was therefore retried up to
 * maxRetries times with backoff, per shard, from every worker. The signal that exists to
 * shed load amplified it instead.
 *
 * Fully offline: a local HTTP server stands in for a shard. No Solr, no Redis, no API.
 */

const assert = require('chai').assert
const http = require('http')

const {
  SolrHttpError,
  solrHttpError,
  parseRetryAfter,
  isRetriable
} = require('../../lib/solrHttpError')

describe('Solr 429 handling', () => {
  describe('parseRetryAfter', () => {
    it('parses delta-seconds', () => {
      assert.strictEqual(parseRetryAfter('5'), 5000)
      assert.strictEqual(parseRetryAfter('120'), 120000)
    })

    it('treats 0 as retry-immediately, not as absent', () => {
      // 0 is a legitimate value; callers must not confuse it with null
      assert.strictEqual(parseRetryAfter('0'), 0)
    })

    it('parses an HTTP-date', () => {
      const now = Date.parse('2026-10-12T12:00:00Z')
      const when = new Date(now + 30000).toUTCString()
      const got = parseRetryAfter(when, now)
      // whole-second resolution in the date format
      assert.closeTo(got, 30000, 1000)
    })

    it('clamps a past HTTP-date to zero rather than going negative', () => {
      const now = Date.parse('2026-10-12T12:00:00Z')
      const past = new Date(now - 60000).toUTCString()
      assert.strictEqual(parseRetryAfter(past, now), 0)
    })

    it('returns null when absent, empty, or unparseable', () => {
      assert.isNull(parseRetryAfter(undefined))
      assert.isNull(parseRetryAfter(null))
      assert.isNull(parseRetryAfter(''))
      assert.isNull(parseRetryAfter('   '))
      assert.isNull(parseRetryAfter('soon'))
    })
  })

  describe('solrHttpError', () => {
    it('carries the status code', () => {
      const err = solrHttpError({ statusCode: 429, headers: {} }, 'overloaded')
      assert.instanceOf(err, SolrHttpError)
      assert.strictEqual(err.statusCode, 429)
    })

    it('carries Retry-After when present', () => {
      const err = solrHttpError({ statusCode: 429, headers: { 'retry-after': '7' } }, '')
      assert.strictEqual(err.retryAfterMs, 7000)
    })

    it('reports overload for 429 and 503 only', () => {
      assert.isTrue(solrHttpError({ statusCode: 429, headers: {} }, '').isOverloaded)
      assert.isTrue(solrHttpError({ statusCode: 503, headers: {} }, '').isOverloaded)
      assert.isFalse(solrHttpError({ statusCode: 400, headers: {} }, '').isOverloaded)
      assert.isFalse(solrHttpError({ statusCode: 500, headers: {} }, '').isOverloaded)
    })

    it('sets .status for overload codes so app.js propagates them to the client', () => {
      // app.js's terminal handler reads error.status
      assert.strictEqual(solrHttpError({ statusCode: 429, headers: {} }, '').status, 429)
      assert.strictEqual(solrHttpError({ statusCode: 503, headers: {} }, '').status, 503)
    })

    it('does NOT set .status for a Solr-side 400, which is our bug and not the caller\'s', () => {
      const err = solrHttpError({ statusCode: 400, headers: {} }, 'bad query')
      assert.isUndefined(err.status)
      assert.strictEqual(err.statusCode, 400)
    })

    it('truncates the body to the requested length', () => {
      const err = solrHttpError({ statusCode: 500, headers: {} }, 'x'.repeat(1000), { maxBodyLength: 10 })
      assert.include(err.message, 'x'.repeat(10))
      assert.notInclude(err.message, 'x'.repeat(11))
    })
  })

  describe('isRetriable', () => {
    it('retries a transport error (no statusCode) — unchanged behavior', () => {
      assert.isTrue(isRetriable(new Error('socket hang up')))
    })

    it('retries 5xx', () => {
      assert.isTrue(isRetriable(solrHttpError({ statusCode: 500, headers: {} }, '')))
      assert.isTrue(isRetriable(solrHttpError({ statusCode: 503, headers: {} }, '')))
    })

    it('does NOT retry a 4xx that is not 429', () => {
      assert.isFalse(isRetriable(solrHttpError({ statusCode: 400, headers: {} }, '')))
      assert.isFalse(isRetriable(solrHttpError({ statusCode: 404, headers: {} }, '')))
    })

    it('treats 429 as retriable, but callers must pace it', () => {
      assert.isTrue(isRetriable(solrHttpError({ statusCode: 429, headers: {} }, '')))
    })
  })

  describe('ShardCursorStream against a 429-returning shard', () => {
    let server
    let baseUrl
    let requestCount
    let respondWith

    beforeEach((done) => {
      requestCount = 0
      respondWith = { status: 429, headers: { 'Retry-After': '0' }, body: 'overloaded' }
      server = http.createServer((req, res) => {
        requestCount++
        res.writeHead(respondWith.status, {
          'Content-Type': 'application/json',
          ...respondWith.headers
        })
        res.end(respondWith.body)
      })
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/solr/test`
        done()
      })
    })

    afterEach((done) => { server.close(done) })

    function makeStream (overrides = {}) {
      const ShardCursorStream = require('../../lib/distributed/ShardCursorStream')
      const s = new ShardCursorStream({
        solrUrl: baseUrl,
        shard: 'shard1',
        query: 'q=*:*',
        uniqueKey: 'id',
        ...overrides
      })
      // keep delays short so the suite stays fast
      s.initialRetryDelayMs = 1
      return s
    }

    it('THE REGRESSION: a 429 is not retried on the generic retry budget', async () => {
      const s = makeStream()
      s.maxRetries = 3
      s.maxOverloadRetries = 1

      try {
        await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 429)
      }

      // 1 initial + 1 overload backoff = 2. Before the fix this was 1 + maxRetries = 4.
      assert.strictEqual(requestCount, 2,
        `429 should consume only the overload budget; got ${requestCount} requests`)
      s.destroy()
    })

    it('honours Retry-After rather than its own backoff', async () => {
      respondWith = { status: 429, headers: { 'Retry-After': '1' }, body: '' }
      const s = makeStream()
      s.maxRetries = 3
      s.maxOverloadRetries = 1
      s.initialRetryDelayMs = 1 // would be ~1ms if Retry-After were ignored

      const t0 = Date.now()
      try {
        await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 429)
      }
      const elapsed = Date.now() - t0

      // Retry-After: 1 => ~1000ms wait. Allow slack, but it must clearly exceed the 1ms
      // backoff the generic path would have used.
      assert.isAtLeast(elapsed, 900, 'should have waited out Retry-After')
      s.destroy()
    })

    it('does not retry at all when the overload budget is zero', async () => {
      const s = makeStream()
      s.maxRetries = 3
      s.maxOverloadRetries = 0

      try {
        await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 429)
      }
      assert.strictEqual(requestCount, 1)
      s.destroy()
    })

    it('does not retry a 400 — it would be refused identically', async () => {
      respondWith = { status: 400, headers: {}, body: 'bad query' }
      const s = makeStream()
      s.maxRetries = 3

      try {
        await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 400)
      }
      assert.strictEqual(requestCount, 1, 'a 400 must not be retried')
      s.destroy()
    })

    it('still retries a 500 on the generic budget — unchanged behavior', async () => {
      respondWith = { status: 500, headers: {}, body: 'boom' }
      const s = makeStream()
      s.maxRetries = 2

      try {
        await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 500)
      }
      assert.strictEqual(requestCount, 3, '1 initial + 2 retries')
      s.destroy()
    })

    it('propagates 429 through the main data path (lib/solrjs query)', async () => {
      // Regression: the first version of this fix patched solrjs's subQuery() but not
      // query(), which is the method the main data path and internalQuery actually use.
      // The unit tests above all passed while a real 429 still surfaced as a 500, because
      // the JSON body parsed and internalQuery's own `results.error` branch overwrote it.
      // This asserts the status survives the whole client, not just the helper.
      const Solrjs = require('../../lib/solrjs')
      const client = new Solrjs(baseUrl)
      client.timeout = 5000

      try {
        await client.query('q=*:*&rows=0')
        assert.fail('expected rejection')
      } catch (err) {
        assert.strictEqual(err.statusCode, 429, 'statusCode must survive')
        assert.strictEqual(err.status, 429, 'app.js reads .status')
        assert.strictEqual(err.retryAfterMs, 0, 'Retry-After: 0 from this stub')
      }
    })

    it('leaves a non-overload error body resolving, so APIMethodHandler still sees results.error', async () => {
      // A Solr query error arrives as a parseable body that middleware/APIMethodHandler
      // turns into its own 400. Rejecting every non-2xx would reroute that path.
      respondWith = { status: 400, headers: {}, body: '{"error":{"msg":"undefined field x","code":400}}' }
      const Solrjs = require('../../lib/solrjs')
      const client = new Solrjs(baseUrl)
      client.timeout = 5000

      const result = await client.query('q=bogus:1&rows=0')
      assert.isObject(result.error, 'body should resolve, not reject')
      assert.strictEqual(result.error.code, 400)
    })

    it('recovers when the shard stops shedding', async () => {
      const s = makeStream()
      s.maxRetries = 3
      s.maxOverloadRetries = 2

      // First call 429s, then the server recovers
      server.removeAllListeners('request')
      server.on('request', (req, res) => {
        requestCount++
        if (requestCount === 1) {
          res.writeHead(429, { 'Retry-After': '0' })
          res.end('overloaded')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response: { docs: [] }, nextCursorMark: '*' }))
      })

      const result = await s._requestWithRetry(`${baseUrl}/select`, 'q=*:*')
      assert.isObject(result)
      assert.strictEqual(requestCount, 2)
      s.destroy()
    })
  })
})
