/**
 * The /admin authorization gate.
 *
 * Offline: exercises the real middleware against synthetic req/res objects. No API,
 * Solr or Redis.
 *
 * THE NEGATIVE CASES ARE THE POINT. This gate's failure mode is silent over-permission —
 * it would still appear to "work" for the operator while admitting everyone. The single
 * most important case here is that a NON-LOOPBACK socket sending
 * `X-Forwarded-For: 127.0.0.1` is refused; that one fails against any implementation
 * that reads `req.ip` instead of the socket, which is the natural way to write this.
 */

const assert = require('chai').assert
const Config = require('../../config')
const adminGate = require('../../middleware/adminGate')

const TOKEN = 'test-admin-token-value'

/** Minimal req double. `peer` is the TCP source address — the thing that must decide. */
function mkReq ({ peer = '127.0.0.1', token = TOKEN, headers = {}, url = '/admin/ping' } = {}) {
  const hdrs = Object.assign({}, headers)
  if (token !== null) hdrs['x-admin-token'] = token
  return {
    socket: { remoteAddress: peer },
    connection: { remoteAddress: peer },
    originalUrl: url,
    headers: hdrs,
    get (name) { return hdrs[String(name).toLowerCase()] }
  }
}

/** Minimal res double that records the terminal status/body. */
function mkRes () {
  const res = { statusCode: null, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

/** Run the gate; resolve 'next' if it passed, else the {status, body}. */
function run (req) {
  const res = mkRes()
  let passed = false
  const origLog = console.log
  const origErr = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    adminGate(req, res, () => { passed = true })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return passed ? 'next' : { status: res.statusCode, body: res.body }
}

describe('admin gate', function () {
  let saved

  beforeEach(function () { saved = Config.get('admin') })
  afterEach(function () { Config.set('admin', saved) })

  const enable = (over = {}) =>
    Config.set('admin', Object.assign({ enabled: true, token: TOKEN }, over))

  describe('the header-spoofing cases — these must never pass', function () {
    beforeEach(enable)

    it('REFUSES a non-loopback peer claiming X-Forwarded-For: 127.0.0.1', function () {
      // The case that fails against any req.ip-based implementation.
      const out = run(mkReq({ peer: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } }))
      assert.notEqual(out, 'next')
      assert.equal(out.status, 403)
    })

    it('REFUSES a non-loopback peer claiming X-Real-IP: 127.0.0.1', function () {
      const out = run(mkReq({ peer: '203.0.113.9', headers: { 'x-real-ip': '127.0.0.1' } }))
      assert.notEqual(out, 'next')
      assert.equal(out.status, 403)
    })

    it('REFUSES a non-loopback peer claiming a loopback Host', function () {
      const out = run(mkReq({ peer: '203.0.113.9', headers: { host: 'localhost:13001' } }))
      assert.notEqual(out, 'next')
    })

    it('REFUSES the host\'s OWN public address', function () {
      // Measured on alpha: elm reaches itself over 140.221.39.6, and the cache warmer
      // did exactly that via alpha.bv-brc.org. On-host is not the same as loopback, and
      // admitting the public address would admit anything able to route as this host.
      const out = run(mkReq({ peer: '::ffff:140.221.39.6' }))
      assert.notEqual(out, 'next')
      assert.equal(out.status, 403)
      assert.match(out.body.error, /127\.0\.0\.1/, 'the message must say what to use instead')
    })
  })

  describe('both factors are required', function () {
    beforeEach(enable)

    it('refuses loopback with no token', function () {
      assert.equal(run(mkReq({ token: null })).status, 403)
    })

    it('refuses loopback with a wrong token', function () {
      assert.equal(run(mkReq({ token: 'wrong' })).status, 403)
    })

    it('refuses loopback with a token of the right length but wrong bytes', function () {
      const same = 'x'.repeat(TOKEN.length)
      assert.equal(run(mkReq({ token: same })).status, 403)
    })

    it('refuses a correct token from a non-loopback peer', function () {
      assert.equal(run(mkReq({ peer: '203.0.113.9' })).status, 403)
    })

    it('ADMITS loopback with the right token', function () {
      assert.equal(run(mkReq()), 'next')
    })
  })

  describe('every loopback spelling is accepted', function () {
    beforeEach(enable)

    // The listener is dual-stack (`:::13001`), so IPv4 clients arrive IPv4-mapped.
    // Matching only '127.0.0.1' would refuse real local callers and read as a bug.
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      it(`admits ${peer}`, function () {
        assert.equal(run(mkReq({ peer })), 'next')
      })
    }
  })

  describe('configuration', function () {
    it('ships DISABLED', function () {
      Config.set('admin', saved)
      const cfg = Config.get('admin') || {}
      assert.notStrictEqual(cfg.enabled, true,
        'an admin surface must not appear on upgrade')
    })

    it('404s when disabled — not 403, so the surface is not advertised', function () {
      Config.set('admin', { enabled: false, token: TOKEN })
      const out = run(mkReq())
      assert.equal(out.status, 404)
    })

    it('404s when disabled even with a valid token from loopback', function () {
      Config.set('admin', { enabled: false, token: TOKEN })
      assert.equal(run(mkReq()).status, 404)
    })

    it('fails CLOSED when enabled with no token configured', function () {
      // Must not degrade to address-only. An operator who forgets the token gets a
      // refusal, not a quietly weaker gate.
      enable({ token: null })
      const out = run(mkReq({ token: 'anything' }))
      assert.equal(out.status, 403)
      assert.match(out.body.error, /not configured/i)
    })

    it('fails closed when the admin config block is absent entirely', function () {
      Config.set('admin', undefined)
      assert.equal(run(mkReq()).status, 404)
    })
  })

  describe('hostile input', function () {
    beforeEach(enable)

    it('refuses a request with no socket at all', function () {
      const req = mkReq()
      delete req.socket
      delete req.connection
      assert.equal(run(req).status, 403)
    })

    it('refuses when the peer address is empty', function () {
      assert.equal(run(mkReq({ peer: '' })).status, 403)
    })

    it('does not accept a loopback-prefixed impostor address', function () {
      for (const peer of ['127.0.0.1.evil.com', '1127.0.0.1', '127.0.0.10', '::1:1']) {
        assert.notEqual(run(mkReq({ peer })), 'next', `must refuse ${peer}`)
      }
    })
  })
})
