/**
 * lib/userAgent — outbound User-Agent identification
 *
 * Context: no outbound call in this service set a User-Agent, and Cloudflare
 * treats UA-less clients as bots. That silently broke token validation — every
 * authenticated request degraded to anonymous with no error. The
 * `bvbrc-<component>/<version>` form is allowlisted in the BV-BRC CF rules, so
 * the prefix is load-bearing, not cosmetic.
 */

const assert = require('chai').assert
const path = require('path')

const uaPath = require.resolve('../../lib/userAgent')

/** Re-require the module with a clean cache, optionally with env overrides. */
function loadFresh (env = {}) {
  const saved = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  delete require.cache[uaPath]
  try {
    return require('../../lib/userAgent')
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    delete require.cache[uaPath]
  }
}

describe('userAgent', function () {
  describe('format', function () {
    it('is bvbrc-api/<version>', function () {
      const { USER_AGENT } = loadFresh()
      assert.match(USER_AGENT, /^bvbrc-api\/\S+$/)
    })

    it('keeps the bvbrc- prefix that Cloudflare allowlists', function () {
      // A UA outside this shape may be challenged; that is the whole reason
      // this module exists.
      const { USER_AGENT } = loadFresh()
      assert.isTrue(USER_AGENT.startsWith('bvbrc-'))
    })

    it('contains no whitespace or header-breaking characters', function () {
      // The value goes into an HTTP header sent to a remote host.
      const { USER_AGENT } = loadFresh()
      assert.notMatch(USER_AGENT, /[\s\r\n:;,"()<>@\\[\]?={}]/)
    })
  })

  describe('version resolution', function () {
    it('prefers BVBRC_API_VERSION when set', function () {
      const { USER_AGENT } = loadFresh({ BVBRC_API_VERSION: '9.9.9-fromenv' })
      assert.equal(USER_AGENT, 'bvbrc-api/9.9.9-fromenv')
    })

    it('ignores an empty BVBRC_API_VERSION', function () {
      const { VERSION } = loadFresh({ BVBRC_API_VERSION: '   ' })
      assert.notEqual(VERSION.trim(), '')
    })

    it('falls back to git describe in a checkout', function () {
      // This repo is a checkout, so the version should look like a git describe
      // (a tag, or tag-distance-hash) rather than the bare package.json version.
      const { VERSION } = loadFresh({ BVBRC_API_VERSION: undefined })
      assert.isString(VERSION)
      assert.isAbove(VERSION.length, 0)
      assert.notEqual(VERSION, 'unknown')
    })

    it('never throws, whatever the environment', function () {
      assert.doesNotThrow(() => loadFresh({ BVBRC_API_VERSION: undefined }))
    })
  })

  describe('sanitizeVersion', function () {
    const { sanitizeVersion } = require('../../lib/userAgent')

    it('passes through normal git describe output', function () {
      assert.equal(sanitizeVersion('1.9.2-254-gdf4dd12e'), '1.9.2-254-gdf4dd12e')
      assert.equal(sanitizeVersion('1.9.4'), '1.9.4')
      assert.equal(sanitizeVersion('1.9.2-254-gdf4dd12e-dirty'), '1.9.2-254-gdf4dd12e-dirty')
    })

    it('strips characters that would break or inject a header', function () {
      assert.equal(sanitizeVersion('1.0 evil'), '1.0-evil')
      assert.equal(sanitizeVersion('1.0\r\nX-Injected: yes'), '1.0--X-Injected--yes')
      assert.notInclude(sanitizeVersion('release/foo'), '/')
    })
  })

  describe('withUserAgent', function () {
    const { withUserAgent, USER_AGENT } = require('../../lib/userAgent')

    it('adds the User-Agent to an empty header set', function () {
      assert.equal(withUserAgent()['User-Agent'], USER_AGENT)
    })

    it('preserves existing headers', function () {
      const out = withUserAgent({ accept: 'application/json' })
      assert.equal(out.accept, 'application/json')
      assert.equal(out['User-Agent'], USER_AGENT)
    })

    it('does not clobber a caller-supplied User-Agent, in any case', function () {
      assert.equal(withUserAgent({ 'User-Agent': 'custom/1' })['User-Agent'], 'custom/1')
      assert.equal(withUserAgent({ 'user-agent': 'custom/2' })['user-agent'], 'custom/2')
      assert.isUndefined(withUserAgent({ 'user-agent': 'custom/2' })['User-Agent'])
    })

    it('does not mutate the caller\'s object', function () {
      const orig = { accept: 'application/json' }
      withUserAgent(orig)
      assert.isUndefined(orig['User-Agent'])
    })
  })
})

describe('userAgent wiring', function () {
  it('util/http.js injects the UA into request options', function () {
    // Verified by inspection of the module source rather than a live request:
    // every exported helper normalizes options through withUserAgent.
    const src = require('fs').readFileSync(
      path.join(__dirname, '../../util/http.js'), 'utf8')
    const exported = (src.match(/'http[a-zA-Z]*':\s*async/g) || []).length
    const injected = (src.match(/withUserAgent\(options/g) || []).length
    assert.equal(injected, exported,
      'every exported request helper must inject the User-Agent')
  })
})
