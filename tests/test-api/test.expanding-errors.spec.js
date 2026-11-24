/**
 * ExpandingQuery error-path tests — ExpandingQuery.js
 *
 * PLAN_ELIMINATE_SELF_CALL.md step 6. tests/test-api/test.expanding.spec.js pins the happy
 * paths of the RQL expanders; like the /data characterization suite before it, it asserts
 * nothing about failures — which is how the defect below survived.
 *
 * WHAT THIS IS GUARDING
 * ---------------------
 * `runJoinQuery` and `runSDISubQuery` used to resolve their sub-queries with an HTTP call to
 * the API's own listening port, then reach straight into the parsed body:
 *
 *     .then((body) => Object.keys(JSON.parse(body).facet_counts.facet_fields[field]))
 *
 * `util/http.js`'s httpRequest discards res.statusCode and resolves the body regardless, so a
 * 400/500 from the sub-query arrived looking like a result. Either JSON.parse threw, or it
 * succeeded and `.facet_counts` was undefined and the next dereference threw. Both throws
 * happened inside the SUCCESS handler of a `.then(ok, fail)` pair, which `fail` does not
 * catch, so:
 *
 *   1. the rejection went unhandled;
 *   2. --unhandled-rejections=strict turned it into an uncaughtException;
 *   3. app.js:34 swallowed that and kept running;
 *   4. the request never reached next() -- it hung forever, holding a worker slot;
 *   5. async_hooks state was now corrupt, and the NEXT Solr-backed request aborted the
 *      process: "Assertion failed: (trigger_async_id) >= (-1)".
 *
 * Every case in the "malformed sub-query" block below reproduced that 3/3 against the
 * pre-conversion code, each from ONE unauthenticated request, with the abort landing on
 * ExpandingQuery.js:68. All three triggers are ordinary client mistakes. The "survives"
 * test at the bottom is the regression test for the abort; the short per-request timeouts
 * are what turn a hang into a failure instead of a stall.
 *
 * NOTE ON A DELIBERATE BEHAVIOR CHANGE
 * ------------------------------------
 * A failed join() sub-query now propagates to a 400 instead of degrading to
 * `in(field,(NOT_A_VALID_ID))` -> HTTP 200 with zero rows. There was no working behavior to
 * preserve: every reachable error hung the request instead. GenomeGroup()/FeatureGroup()
 * keep their degradation, because that one IS reachable and observed today — the
 * "workspace" block pins it.
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
// response to any of these is well under a second.
const ERROR_TIMEOUT_MS = 20000

function post (collection, rql, { timeout = ERROR_TIMEOUT_MS, accept = 'application/solr+json' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${API_URL}/${collection}/`)
    const mod = u.protocol === 'https:' ? https : http
    const body = Buffer.from(rql, 'utf8')
    const req = mod.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        Accept: accept,
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'Content-Length': body.length
      }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error(`HUNG: no response within ${timeout}ms`)))
    req.write(body)
    req.end()
  })
}

function get (path, { timeout = ERROR_TIMEOUT_MS, accept = 'application/json' } = {}) {
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

// A genome that exists in every deployment this suite is likely to run against.
const KNOWN_GENOME = '83332.12'

// Each of these hung the worker and then aborted the process before the conversion.
const MALFORMED_JOIN = [
  ['an undefined field in the sub-query',
    `join(genome,eq(no_such_field_xyz,1),genome_id)&select(feature_id)&limit(1)`],
  ['an unknown sub-query collection',
    `join(no_such_collection,eq(a,b),genome_id)&select(feature_id)&limit(1)`],
  // The `&` and `=` are encoded so they survive RQL parsing as part of a value and only
  // become a separate parameter at Solr's decoding layer. SolrQuerySanitizer is what stops
  // this; internalQuery runs it on the converted Solr string, the same point the HTTP path
  // did. Before the conversion the sub-request WAS correctly rejected with a 400 — and that
  // 400 is exactly what killed the worker on the way back.
  ['a smuggled shards parameter',
    `join(genome,eq(genome_id,${KNOWN_GENOME}%26shards%3Dhttp%3A%2F%2Fevil),genome_id)&select(feature_id)&limit(1)`]
]

describe('ExpandingQuery — error paths', function () {
  this.timeout(120000)

  let apiUp = false

  before(async function () {
    try {
      const res = await get('/health', { accept: '*/*' })
      apiUp = res.status === 200
    } catch (e) {
      apiUp = false
    }
    if (!apiUp) console.log(`    [skip] API not reachable at ${API_URL}`)
  })

  beforeEach(function () {
    if (!apiUp) this.skip()
  })

  describe('join() — a malformed sub-query is answered, not hung', function () {
    MALFORMED_JOIN.forEach(([label, rql]) => {
      it(`returns 4xx for ${label}`, async function () {
        const res = await post('genome_feature', rql)
        assert.isAtLeast(res.status, 400, `expected a client error, got ${res.status}`)
        assert.isBelow(res.status, 500,
          `a bad client query must not be reported as a server error (got ${res.status})`)
      })
    })

    it('the error body is JSON naming the sub-query, not a raw database error string', async function () {
      const res = await post('genome_feature', MALFORMED_JOIN[1][1])
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(res.body) },
        `body was not JSON: ${res.body.slice(0, 200)}`)
      assert.property(parsed, 'message')
      assert.match(parsed.message, /sub query/i,
        'the message should say which stage failed, not just "Invalid query"')
      assert.notMatch(res.body, /A Database Error Occured/i)
      assert.notMatch(res.body, /org\.apache\.solr/i)
    })

    it('a failed join does not silently become an empty result set', async function () {
      // THE behavior change. `in(genome_id,(NOT_A_VALID_ID))` would have been an HTTP 200
      // with numFound 0 -- indistinguishable, to a client, from "your filter matched
      // nothing". That is the failure mode this codebase repeatedly warns about.
      const res = await post('genome_feature', MALFORMED_JOIN[0][1])
      assert.notEqual(res.status, 200,
        'a failed sub-query was reported as a successful empty result')
    })
  })

  describe('join() — the paths that do work still do', function () {
    it('resolves a matching sub-query into rows', async function () {
      const res = await post('genome_feature',
        `join(genome,eq(genome_id,${KNOWN_GENOME}),genome_id)&eq(feature_type,CDS)&select(feature_id)&limit(1)`)
      assert.equal(res.status, 200, res.body.slice(0, 200))
      const parsed = JSON.parse(res.body)
      assert.isAbove(parsed.response.numFound, 0)
    })

    it('a sub-query that matches nothing is a 400, not a hang', async function () {
      // An empty facet map yields Object.keys({}) === [], hence `in(genome_id,())`, which
      // the RQL parser rejects. Pinned here because it is easy to "fix" this into a silent
      // empty 200 and reintroduce the failure mode above.
      const res = await post('genome_feature',
        'join(genome,eq(genome_id,999999999.9),genome_id)&select(feature_id)&limit(1)')
      assert.isAtLeast(res.status, 400)
      assert.isBelow(res.status, 500)
    })
  })

  describe('secondDegreeInteraction()', function () {
    it('returns an empty result for a feature with no interactions', async function () {
      // Unlike join(), an empty SDI facet is a legitimate answer: runSDISubQuery returns []
      // and the caller emits `(NOT_A_VALID_ID)` on purpose, because "this feature interacts
      // with nothing" is a real result rather than a failure.
      const res = await post('ppi', 'secondDegreeInteraction(NOT.A.FEATURE)&limit(5)')
      assert.equal(res.status, 200, res.body.slice(0, 200))
      assert.equal(JSON.parse(res.body).response.numFound, 0)
    })
  })

  describe('workspace expanders keep degrading rather than failing', function () {
    it('an unreadable GenomeGroup yields an empty result, not an error', async function () {
      // Deliberately unchanged. This path IS reachable today (an anonymous caller, or a
      // path the user cannot read), and clients depend on the empty answer.
      const res = await post('genome',
        'in(genome_id,GenomeGroup(%2Fnobody%40patricbrc.org%2Fhome%2Fnope%2Fnope))&select(genome_id)&limit(1)')
      assert.equal(res.status, 200, res.body.slice(0, 200))
      assert.equal(JSON.parse(res.body).response.numFound, 0)
    })
  })

  describe('the process survives a malformed sub-query', function () {
    MALFORMED_JOIN.forEach(([label, rql]) => {
      it(`serves a normal Solr-backed request after ${label}`, async function () {
        // THE regression test for the async_hooks abort. Before the conversion each of these
        // killed the worker 3/3: the join request hung for the full timeout, and the request
        // after it aborted the process, so this assertion fails with ECONNRESET rather than
        // a bad status.
        await post('genome_feature', rql).catch((e) => ({ status: `ERR ${e.message}` }))

        const good = await post('genome',
          `eq(genome_id,${KNOWN_GENOME})&select(genome_id,genome_name)`, { timeout: 60000 })
        assert.equal(good.status, 200,
          'the API stopped serving after a malformed join -- worker likely aborted')
        assert.equal(JSON.parse(good.body).response.numFound, 1)
      })
    })
  })
})
