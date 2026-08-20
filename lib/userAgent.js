/**
 * User-Agent for outbound HTTP requests
 *
 * Every request this service makes to another host should identify itself. Until
 * now none did, which had a concrete cost: Cloudflare treats UA-less clients as
 * bots and returns a 403 challenge page. That silently broke token validation
 * (`p3-user` fetches the signing key over HTTP and got HTML instead of JSON), so
 * every authenticated request degraded to anonymous with no error anywhere.
 *
 * The `bvbrc-<component>/<version>` form is allowlisted in the BV-BRC Cloudflare
 * rules. Keep that prefix — a UA that does not match it may be challenged.
 *
 * Version resolution, in order:
 *   1. BVBRC_API_VERSION env var — for deploys that are not a git checkout
 *   2. `git describe --tags --always --dirty` — the normal case; the service runs
 *      from a checkout, so this yields the exact tree (e.g. `1.9.4`, or
 *      `1.9.2-254-gdf4dd12e` when HEAD is past the last tag)
 *   3. package.json version — last resort
 *
 * Resolved once at module load. `git describe` costs ~40ms, which is fine at
 * startup and would not be per request.
 */

const { execFileSync } = require('child_process')
const path = require('path')

const COMPONENT = 'bvbrc-api'

/**
 * Ask git for a description of the working tree.
 *
 * @returns {string|null} e.g. '1.9.4', '1.9.2-254-gdf4dd12e', or null if git is
 *   unavailable, this is not a checkout, or the call fails for any reason
 */
function gitDescribe () {
  try {
    const out = execFileSync(
      'git',
      ['describe', '--tags', '--always', '--dirty'],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }
    ).trim()

    return out || null
  } catch (err) {
    // Not a checkout, git missing, shallow clone with no tags — all fine, fall
    // through to package.json. Never let versioning break startup.
    return null
  }
}

/**
 * Strip anything that cannot appear in a User-Agent token.
 *
 * RFC 9110 product-version is a `token`; whitespace and separators would split
 * the header or invalidate it. Guards against a stray tag name breaking the UA
 * (and, since the value reaches a remote host, against header injection).
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeVersion (value) {
  return String(value).replace(/[^A-Za-z0-9._+-]/g, '-')
}

/**
 * Resolve the version string.
 *
 * @returns {string}
 */
function resolveVersion () {
  const fromEnv = process.env.BVBRC_API_VERSION
  if (fromEnv && fromEnv.trim()) {
    return sanitizeVersion(fromEnv.trim())
  }

  const described = gitDescribe()
  if (described) {
    return sanitizeVersion(described)
  }

  try {
    return sanitizeVersion(require('../package.json').version || 'unknown')
  } catch (err) {
    return 'unknown'
  }
}

const VERSION = resolveVersion()
const USER_AGENT = `${COMPONENT}/${VERSION}`

/**
 * The User-Agent string for outbound requests.
 *
 * @returns {string} e.g. 'bvbrc-api/1.9.2-254-gdf4dd12e'
 */
function userAgent () {
  return USER_AGENT
}

/**
 * Merge the User-Agent into an existing headers object without clobbering an
 * explicit caller-supplied one.
 *
 * @param {Object} [headers] - Existing headers
 * @returns {Object} New headers object including User-Agent
 */
function withUserAgent (headers = {}) {
  const hasUA = Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')
  if (hasUA) return { ...headers }
  return { ...headers, 'User-Agent': USER_AGENT }
}

module.exports = {
  userAgent,
  withUserAgent,
  USER_AGENT,
  VERSION,
  COMPONENT,
  // exported for tests
  sanitizeVersion,
  resolveVersion
}
