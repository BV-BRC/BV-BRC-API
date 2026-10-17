/**
 * util/http.js wall-clock deadlines — PLAN_ELIMINATE_SELF_CALL.md step 7.
 *
 * WHAT THIS IS GUARDING
 * ---------------------
 * `util/http.js` had no timeout mechanism at all — not unset, absent. Every helper in it
 * could hang until the OS tore down the TCP session (~166s measured), and it carries the
 * Workspace API calls plus every remaining self-call site. Against the pre-change module
 * each black-hole case below never settles, so these tests fail by mocha timeout rather
 * than by assertion — which is the point.
 *
 * The interesting case is "bounds time spent QUEUED for a socket". `req.setTimeout` — what
 * lib/solrjs's armTimeout() uses, and what PR #203 added to the Solr path — is a *socket*
 * timeout: its timer does not start until the agent assigns a socket, so time queued
 * behind maxSockets is unbounded. A deadline started at request creation is the only thing
 * that covers it. Swap armDeadline's setTimeout for req.setTimeout and that one test hangs
 * while the rest still pass.
 *
 * Fully offline: two local servers, no API, no Solr, no Redis.
 */

const assert = require('chai').assert
const http = require('http')
const path = require('path')

const HTTP_MODULE = path.join(__dirname, '../../util/http.js')

// Deliberately short. A real deadline is 120s; these only need to prove the timer exists,
// fires, and is cancelled.
const SHORT_MS = 500

describe('util/http.js — wall-clock deadlines', function () {
  this.timeout(20000)

  let blackHole, blackHolePort
  let echo, echoPort
  const openSockets = []

  before(function (done) {
    // Accepts the connection, reads the request, and answers nothing, ever. This is the
    // stale-keepalive / shed-connection shape from Docs/GENBANK_DOWNLOAD_PERFORMANCE.md.
    blackHole = http.createServer(() => {})
    blackHole.on('connection', (s) => openSockets.push(s))

    echo = http.createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    echo.on('connection', (s) => openSockets.push(s))

    blackHole.listen(0, '127.0.0.1', () => {
      blackHolePort = blackHole.address().port
      echo.listen(0, '127.0.0.1', () => {
        echoPort = echo.address().port
        done()
      })
    })
  })

  after(function (done) {
    // The pending black-hole requests hold their sockets open; without this the servers
    // never close and mocha never exits.
    openSockets.forEach((s) => s.destroy())
    blackHole.close(() => echo.close(() => done()))
  })

  function freshModule (env) {
    const saved = process.env.HTTP_REQUEST_TIMEOUT_MS
    if (env === undefined) {
      delete process.env.HTTP_REQUEST_TIMEOUT_MS
    } else {
      process.env.HTTP_REQUEST_TIMEOUT_MS = env
    }
    delete require.cache[require.resolve(HTTP_MODULE)]
    const mod = require(HTTP_MODULE)
    delete require.cache[require.resolve(HTTP_MODULE)]
    if (saved === undefined) {
      delete process.env.HTTP_REQUEST_TIMEOUT_MS
    } else {
      process.env.HTTP_REQUEST_TIMEOUT_MS = saved
    }
    return mod
  }

  const httpUtil = require('../../util/http')

  function blackHoleOptions (extra) {
    return {
      hostname: '127.0.0.1',
      port: blackHolePort,
      path: '/never',
      ...extra
    }
  }

  describe('a server that never answers', function () {
    it('httpGet rejects rather than hanging', async function () {
      const started = Date.now()
      let err
      try {
        await httpUtil.httpGet(blackHoleOptions({ timeout: SHORT_MS }))
      } catch (e) {
        err = e
      }
      assert.isDefined(err, 'httpGet resolved or hung; it must reject on deadline')
      assert.equal(err.code, 'ETIMEDOUT', err.message)
      assert.match(err.message, /timed out after 500ms/)
      assert.isBelow(Date.now() - started, 5000)
    })

    it('httpRequest rejects rather than hanging', async function () {
      let err
      try {
        await httpUtil.httpRequest(blackHoleOptions({ method: 'POST', timeout: SHORT_MS }), 'x')
      } catch (e) {
        err = e
      }
      assert.isDefined(err, 'httpRequest resolved or hung')
      assert.equal(err.code, 'ETIMEDOUT', err.message)
    })

    it('httpRequestWithStatus rejects rather than hanging', async function () {
      // The helper multiQuery and dataRouter reach Solr-backed sub-queries through.
      let err
      try {
        await httpUtil.httpRequestWithStatus(
          blackHoleOptions({ method: 'POST', timeout: SHORT_MS }), 'x')
      } catch (e) {
        err = e
      }
      assert.isDefined(err, 'httpRequestWithStatus resolved or hung')
      assert.equal(err.code, 'ETIMEDOUT', err.message)
    })

    it('the message names the host and path but not the query string', async function () {
      // These messages reach clients, and a self-call path carries the caller's filter.
      let err
      try {
        await httpUtil.httpGet(blackHoleOptions({
          path: '/never?q=secret_filter_value',
          timeout: SHORT_MS
        }))
      } catch (e) {
        err = e
      }
      assert.isDefined(err)
      assert.include(err.message, `127.0.0.1:${blackHolePort}/never`)
      assert.notInclude(err.message, 'secret_filter_value')
    })
  })

  describe('the deadline bounds time spent QUEUED for a socket', function () {
    it('a request that never gets a socket still times out', async function () {
      // THE test for the design choice. With maxSockets:1 the first request owns the only
      // socket forever, so the second spends its entire life in the agent's queue with no
      // socket and therefore no socket timer. Measured against a black-hole server, a
      // req.setTimeout of 2000ms was still pending at 6000ms — gap 1 of two in
      // Docs/HANG-INVESTIGATION-2026-08-24.md.
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })

      // Fire and forget: this one is meant never to settle. after() destroys its socket,
      // which rejects it, so the catch is required or mocha reports an unhandled rejection.
      httpUtil.httpGet(blackHoleOptions({ agent, timeout: 0 })).catch(() => {})

      // Give the hog time to claim the socket before the queued request is created.
      await new Promise((resolve) => setTimeout(resolve, 200))

      const started = Date.now()
      let err
      try {
        await httpUtil.httpGet(blackHoleOptions({ agent, path: '/queued', timeout: 600 }))
      } catch (e) {
        err = e
      }
      const elapsed = Date.now() - started
      assert.isDefined(err, 'the queued request never settled — the deadline is socket-scoped')
      assert.equal(err.code, 'ETIMEDOUT', err.message)
      assert.isBelow(elapsed, 4000, `queued request took ${elapsed}ms to time out`)
      agent.destroy()
    })
  })

  describe('the timer does not outlive its request', function () {
    it('a completed request leaves no armed timer behind', async function () {
      // An uncancelled timer keeps the event loop alive for the rest of its interval. With
      // the 120s default that hangs every short-lived script, and mocha runs without
      // --exit, so a leak here stalls the whole suite rather than failing one test.
      //
      // Counting active Timeout resources is too noisy to assert on — an accepted
      // connection arms server-side keepAlive/headers timers of its own. So watch the
      // timer with our distinctive delay specifically.
      const DISTINCTIVE = 3600000
      const created = []
      const realSet = global.setTimeout
      const realClear = global.clearTimeout
      global.setTimeout = function (fn, delay, ...rest) {
        const t = realSet(fn, delay, ...rest)
        created.push({ t, delay, cleared: false })
        return t
      }
      global.clearTimeout = function (t) {
        const rec = created.find((c) => c.t === t)
        if (rec) { rec.cleared = true }
        return realClear(t)
      }

      let body
      try {
        body = await httpUtil.httpGet({
          hostname: '127.0.0.1',
          port: echoPort,
          path: '/ok',
          timeout: DISTINCTIVE
        })
      } finally {
        global.setTimeout = realSet
        global.clearTimeout = realClear
      }

      assert.equal(body, 'ok')
      const ours = created.filter((c) => c.delay === DISTINCTIVE)
      assert.lengthOf(ours, 1, 'the deadline was never armed, so this test proves nothing')
      assert.isTrue(ours[0].cleared, 'the request left its deadline timer armed')
    })
  })

  describe('configuration', function () {
    it('defaults to 120s, matching SOLR_REQUEST_TIMEOUT_MS', function () {
      assert.equal(freshModule(undefined).DEFAULT_TIMEOUT_MS, 120000)
    })

    it('HTTP_REQUEST_TIMEOUT_MS overrides the default', async function () {
      const mod = freshModule('300')
      assert.equal(mod.DEFAULT_TIMEOUT_MS, 300)

      // And a call that passes no explicit timeout picks it up.
      let err
      try {
        await mod.httpGet(blackHoleOptions({ path: '/env' }))
      } catch (e) {
        err = e
      }
      assert.isDefined(err, 'the default deadline did not fire')
      assert.equal(err.code, 'ETIMEDOUT', err.message)
      assert.match(err.message, /timed out after 300ms/)
    })

    it('an explicit timeout of 0 disables the deadline', async function () {
      // Preserves the escape hatch for a caller that genuinely wants to wait — and proves
      // the rejections above come from the deadline rather than from the server.
      const settled = httpUtil.httpGet(blackHoleOptions({ path: '/forever', timeout: 0 }))
        .then(() => 'resolved', () => 'rejected')
      const outcome = await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 1500))
      ])
      assert.equal(outcome, 'still pending')
      settled.catch(() => {})
    })
  })
})
