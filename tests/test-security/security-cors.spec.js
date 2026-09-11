/**
 * Security tests for the CORS policy (util/corsOptions.js).
 *
 * Background: the previous inline cors configuration misspelled two option
 * keys -- `credential` (cors reads `credentials`) and `allowHeaders` (cors
 * reads `allowedHeaders`). Both were inert, and they failed in opposite
 * directions: Access-Control-Allow-Credentials was never sent, while the
 * header list fell through to reflecting whatever the browser asked for.
 *
 * Correcting only the spelling would be a regression rather than a fix:
 * `origin: true` reflects any origin, and a working `credentials: true`
 * alongside it would grant any site on the internet credentialed access with
 * a victim's ambient authority. Nothing exercises the cross-origin credentialed
 * path today, so no functional test would have caught it. These tests exist to
 * make that specific mistake impossible to reintroduce quietly.
 *
 * The policy under test splits by request kind, because p3_api is a *public*
 * data API:
 *   - anonymous cross-origin reads stay open to every origin
 *   - credentials (ACAC) are granted only to allowlisted origins
 */

const assert = require('chai').assert
const express = require('express')
const Http = require('http')
const cors = require('cors')

const corsOptions = require('../../util/corsOptions')

const ALLOWED = 'https://www.bv-brc.org'
const OTHER_ALLOWED = 'https://alpha.bv-brc.org'
const EVIL = 'https://evil.example.com'

function startServer (allowlist) {
  const app = express()
  app.use(cors(corsOptions({ get: () => allowlist })))
  app.get('/probe', (req, res) => res.json({ ok: true }))
  app.post('/probe', (req, res) => res.json({ ok: true }))
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server))
  })
}

function request (port, method, origin, requestHeaders) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (origin) headers.Origin = origin
    if (method === 'OPTIONS') {
      headers['Access-Control-Request-Method'] = 'POST'
      if (requestHeaders) headers['Access-Control-Request-Headers'] = requestHeaders
    }
    const req = Http.request({ port, path: '/probe', method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('CORS policy', function () {
  describe('isAllowed (exact origin matching)', function () {
    const allowlist = [ALLOWED, OTHER_ALLOWED]

    it('matches an allowlisted origin exactly', function () {
      assert.isTrue(corsOptions.isAllowed(ALLOWED, allowlist))
      assert.isTrue(corsOptions.isAllowed(OTHER_ALLOWED, allowlist))
    })

    it('rejects an origin that merely contains an allowlisted domain', function () {
      // The reason the check is indexOf on the whole serialized origin rather
      // than an endsWith on the domain: a suffix test for '.bv-brc.org' also
      // matches these.
      assert.isFalse(corsOptions.isAllowed('https://evil-bv-brc.org', allowlist))
      assert.isFalse(corsOptions.isAllowed('https://bv-brc.org.attacker.net', allowlist))
      assert.isFalse(corsOptions.isAllowed('https://wwwXbv-brc.org', allowlist))
    })

    it('rejects a scheme or port mismatch', function () {
      assert.isFalse(corsOptions.isAllowed('http://www.bv-brc.org', allowlist))
      assert.isFalse(corsOptions.isAllowed('https://www.bv-brc.org:8443', allowlist))
    })

    it('rejects a trailing slash, which is not part of a serialized origin', function () {
      assert.isFalse(corsOptions.isAllowed('https://www.bv-brc.org/', allowlist))
    })

    it('rejects absent and empty origins', function () {
      assert.isFalse(corsOptions.isAllowed(undefined, allowlist))
      assert.isFalse(corsOptions.isAllowed('', allowlist))
      assert.isFalse(corsOptions.isAllowed(null, allowlist))
    })

    it('rejects everything when the allowlist is empty', function () {
      assert.isFalse(corsOptions.isAllowed(ALLOWED, []))
    })
  })

  describe('configuration guard', function () {
    it('throws when cors_origins is not an array', function () {
      assert.throws(() => corsOptions({ get: () => ALLOWED }), /must be an array/)
    })

    it('defaults to an empty allowlist when cors_origins is unset', function () {
      assert.doesNotThrow(() => corsOptions({ get: () => undefined }))
    })
  })

  describe('emitted headers', function () {
    let server, port

    before(async function () {
      server = await startServer([ALLOWED])
      port = server.address().port
    })

    after(function () {
      if (server) server.close()
    })

    it('grants credentials to an allowlisted origin', async function () {
      const res = await request(port, 'OPTIONS', ALLOWED, 'authorization,content-type')
      assert.equal(res.headers['access-control-allow-origin'], ALLOWED)
      assert.equal(res.headers['access-control-allow-credentials'], 'true')
    })

    it('NEVER grants credentials to a non-allowlisted origin', async function () {
      // The core regression guard. If someone "fixes" the spelling by setting
      // credentials: true unconditionally alongside origin: true, this fails.
      const res = await request(port, 'OPTIONS', EVIL, 'authorization,content-type')
      assert.isUndefined(res.headers['access-control-allow-credentials'])
    })

    it('still allows anonymous cross-origin access from any origin', async function () {
      // p3_api is a public data API. Gating the origin itself would break
      // legitimate third-party consumers, so ACAO is still reflected -- it is
      // only credentials that are restricted.
      const res = await request(port, 'GET', EVIL)
      assert.equal(res.headers['access-control-allow-origin'], EVIL)
      assert.isUndefined(res.headers['access-control-allow-credentials'])
    })

    it('sends the fixed header list rather than reflecting the request', async function () {
      // The allowHeaders typo made cors reflect Access-Control-Request-Headers.
      // With the spelling corrected, an arbitrary header is no longer echoed.
      const res = await request(port, 'OPTIONS', ALLOWED, 'x-totally-made-up')
      const allowed = res.headers['access-control-allow-headers']
      assert.notInclude(allowed, 'x-totally-made-up')
      assert.include(allowed, 'authorization')
      assert.include(allowed, 'content-type')
    })

    it('allows every header the p3 client actually sends', async function () {
      // Tightening from reflection to a fixed list can only break clients by
      // omission, so the list is asserted explicitly.
      const res = await request(port, 'OPTIONS', ALLOWED, 'accept,content-type,authorization,range')
      const allowed = res.headers['access-control-allow-headers'].toLowerCase()
      ;['accept', 'content-type', 'authorization', 'range', 'if-none-match', 'x-range']
        .forEach((h) => assert.include(allowed, h))
    })

    it('allows x-requested-with, which dojo sends by default', async function () {
      // dojo/request/xhr.js:278 sets X-Requested-With: XMLHttpRequest unless a
      // call site passes the key with a falsy value. Many p3 sites do null it
      // out, which makes it easy to conclude it is never sent -- an earlier
      // version of this suite asserted exactly that, and the omission broke
      // production login on p3_user.
      //
      // Most p3_api traffic is same-origin via the relative dataServiceURL and
      // never preflights, but PriorityPathogen.js:418 fetches the absolute
      // https://www.bv-brc.org/api/... with only an `accept` header, so it
      // sends the default cross-origin from every non-production property.
      const res = await request(port, 'OPTIONS', ALLOWED, 'x-requested-with,accept')
      const allowed = res.headers['access-control-allow-headers'].toLowerCase()
      assert.include(allowed, 'x-requested-with')
    })

    it('emits no CORS origin header for a same-origin request', async function () {
      const res = await request(port, 'GET', null)
      assert.isUndefined(res.headers['access-control-allow-origin'])
    })

    it('preserves the exposed-header list', async function () {
      const res = await request(port, 'GET', ALLOWED)
      const exposed = res.headers['access-control-expose-headers']
      ;['facet_counts', 'x-facet-count', 'Content-Range', 'X-Cursor-Mark', 'ETag']
        .forEach((h) => assert.include(exposed, h))
    })
  })

  describe('shipped default (empty allowlist)', function () {
    let server, port

    before(async function () {
      server = await startServer([])
      port = server.address().port
    })

    after(function () {
      if (server) server.close()
    })

    it('reproduces production behavior exactly: origin reflected, no credentials', async function () {
      // Verified against production: an OPTIONS to the live API with an
      // arbitrary Origin returns ACAO for that origin and no ACAC. Shipping
      // an empty allowlist is therefore a no-op for existing deployments.
      const res = await request(port, 'OPTIONS', ALLOWED, 'authorization')
      assert.equal(res.headers['access-control-allow-origin'], ALLOWED)
      assert.isUndefined(res.headers['access-control-allow-credentials'])
    })
  })
})
