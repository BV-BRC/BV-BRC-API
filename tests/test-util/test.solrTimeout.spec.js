/**
 * Wall-clock deadline on the Solr client (lib/solrjs).
 *
 * The defect these cover: armTimeout() used `req.setTimeout`, a socket *inactivity*
 * timer that does not start until the agent assigns a socket. With the pool saturated
 * (maxSockets is 8 on the main path) a request waits in `agent.requests` with no timer
 * running, and Node's http.Agent caps that queue at nothing — there is no maxQueue
 * option. Worst case was (unbounded queue wait) + SOLR_REQUEST_TIMEOUT_MS.
 *
 * The companion trap, found while writing these: simply swapping in a plain setTimeout
 * is not enough. `req.destroy(err)` on a request that has no socket yet emits **no**
 * 'error' event, so nothing rejects the promise — it stays pending for the full queue
 * wait anyway (measured 59.9s against a 1000ms deadline). The deadline has to reject
 * directly. The "bounds time spent QUEUED" case below fails against either mistake.
 *
 * Mirrors tests/test-util/test.httpTimeout.spec.js, which pins the same property for
 * util/http.js. Fully offline: local servers only, no Solr/Redis/API.
 */

const assert = require('chai').assert
const http = require('http')

const Solrjs = require('../../lib/solrjs')

describe('Solrjs wall-clock deadline', () => {
  let blackHole
  let blackHoleUrl

  // A server that accepts connections and never answers — the production failure mode
  // (a pooled keepAlive socket the far side already dropped leaves no FIN).
  beforeEach((done) => {
    blackHole = http.createServer(() => {})
    blackHole.listen(0, '127.0.0.1', () => {
      blackHoleUrl = `http://127.0.0.1:${blackHole.address().port}/solr/test`
      done()
    })
  })

  afterEach((done) => {
    // Several of these deliberately leave a request in flight (the whole point of a
    // black-hole server), and server.close() waits for live connections. Force them
    // shut or the hook times out instead of the test telling us anything useful.
    if (typeof blackHole.closeAllConnections === 'function') {
      blackHole.closeAllConnections()
    }
    blackHole.close(() => done())
  })

  it('query() rejects rather than hanging', async () => {
    const client = new Solrjs(blackHoleUrl)
    client.timeout = 300

    const t0 = Date.now()
    try {
      await client.query('q=*:*&rows=0')
      assert.fail('expected a timeout rejection')
    } catch (err) {
      assert.match(err.message, /timed out after 300ms/)
      assert.isBelow(Date.now() - t0, 2000)
    }
  })

  it('get() rejects rather than hanging', async () => {
    const client = new Solrjs(blackHoleUrl)
    client.timeout = 300

    try {
      await client.get('someid')
      assert.fail('expected a timeout rejection')
    } catch (err) {
      assert.match(err.message, /timed out after 300ms/)
    }
  })

  it('getSchema() rejects rather than hanging', async () => {
    const client = new Solrjs(blackHoleUrl)
    client.timeout = 300

    try {
      await client.getSchema()
      assert.fail('expected a timeout rejection')
    } catch (err) {
      assert.match(err.message, /timed out after 300ms/)
    }
  })

  it('a per-call options.timeout overrides the client-level timeout', async () => {
    const client = new Solrjs(blackHoleUrl)
    client.timeout = 60000 // would outlast the test

    const t0 = Date.now()
    try {
      await client.query('q=*:*&rows=0', { timeout: 300 })
      assert.fail('expected a timeout rejection')
    } catch (err) {
      assert.match(err.message, /timed out after 300ms/)
      assert.isBelow(Date.now() - t0, 2000)
    }
  })

  it('THE REGRESSION: the deadline bounds time spent QUEUED for a socket', async function () {
    // This is the whole point of the change, and the case req.setTimeout fails.
    // maxSockets: 1 — the first request takes the only socket and never returns it, so
    // the second never gets one. Its timer must still fire.
    this.timeout(15000)

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

    const hog = new Solrjs(blackHoleUrl)
    hog.setAgent(agent)
    hog.timeout = 60000
    hog.query('q=*:*&rows=0').catch(() => {}) // occupies the socket

    await new Promise((resolve) => setTimeout(resolve, 100))

    const queued = new Solrjs(blackHoleUrl)
    queued.setAgent(agent)
    queued.timeout = 500

    const t0 = Date.now()
    try {
      await queued.query('q=*:*&rows=0')
      assert.fail('expected a timeout rejection')
    } catch (err) {
      const elapsed = Date.now() - t0
      assert.match(err.message, /timed out after 500ms/)
      // Pre-change this sat pending for the full hog timeout. Generous bound so the
      // assertion is about "bounded at all", not about timer precision.
      assert.isBelow(elapsed, 3000,
        `queued request took ${elapsed}ms — the deadline is not covering queue wait`)
    }

    agent.destroy()
  })

  it('a timeout of 0 disables the deadline', async function () {
    // `timeout: 0` means "wait indefinitely" — a caller that genuinely wants no bound.
    //
    // Asserted against armTimeout directly rather than by starting a real request and
    // watching it not finish: a request that never settles keeps mocha alive, since the
    // suite runs without --exit. A fake req records whether a timer was armed; 'close'
    // is never needed because nothing should be scheduled in the first place.
    this.timeout(5000)

    const { armTimeout } = require('../../lib/solrjs')._testables || {}
    if (typeof armTimeout !== 'function') {
      this.skip() // not exported; the behavioral cases above still cover the main paths
      return
    }

    let destroyed = false
    let closeHandlerAttached = false
    const fakeReq = {
      destroy: () => { destroyed = true },
      once: (ev) => { if (ev === 'close') closeHandlerAttached = true }
    }

    let rejected = false
    armTimeout(fakeReq, 0, () => { rejected = true })
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.isFalse(destroyed, 'timeout: 0 must not destroy the request')
    assert.isFalse(rejected, 'timeout: 0 must not reject')
    assert.isFalse(closeHandlerAttached, 'timeout: 0 should not arm anything to clean up')
  })

  it('a completed request clears its deadline timer', async function () {
    // mocha runs without --exit, so a leaked 120s timer stalls the whole suite rather
    // than failing one test. Cleanup hangs off the request's 'close' event; this checks
    // clearTimeout actually runs.
    //
    // Asserted by counting Timeout handles specifically rather than all active handles:
    // the latter includes this test's own server and sockets, which churn independently.
    this.timeout(5000)

    const ok = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response: { numFound: 0, docs: [] } }))
    })
    await new Promise((resolve) => ok.listen(0, '127.0.0.1', resolve))

    const countTimers = () => process._getActiveHandles()
      .filter((h) => h && h.constructor && h.constructor.name === 'Timeout').length

    const client = new Solrjs(`http://127.0.0.1:${ok.address().port}/solr/test`)
    client.timeout = 30000 // long enough that a leak would stall the suite

    const before = countTimers()
    await client.query('q=*:*&rows=0')
    await new Promise((resolve) => setImmediate(resolve)) // let 'close' fire
    const after = countTimers()

    assert.isAtMost(after, before,
      'the deadline timer was left armed after the request completed')

    await new Promise((resolve) => ok.close(resolve))
  })

  it('a normal response is unaffected by the deadline', async () => {
    const ok = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response: { numFound: 7, docs: [] } }))
    })
    await new Promise((resolve) => ok.listen(0, '127.0.0.1', resolve))

    const client = new Solrjs(`http://127.0.0.1:${ok.address().port}/solr/test`)
    client.timeout = 5000

    const result = await client.query('q=*:*&rows=0')
    assert.strictEqual(result.response.numFound, 7)

    await new Promise((resolve) => ok.close(resolve))
  })
})
