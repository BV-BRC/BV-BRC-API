/*
 * CORS policy for p3_api.
 *
 * The configuration this replaces had two misspelled keys:
 *
 *   credential:   true                 -> cors reads options.credentials
 *   allowHeaders: [...]                -> cors reads options.allowedHeaders
 *
 * Both were therefore inert, and they failed in opposite directions:
 *
 *   - `credential` meant Access-Control-Allow-Credentials was never sent, so
 *     credentialed cross-origin requests have never worked. Nothing depends on
 *     them; the site-facing endpoints were deliberately placed under the site's
 *     own registrable domain, so every real request is same-origin.
 *
 *   - `allowHeaders` meant cors fell through to *reflecting* the browser's
 *     Access-Control-Request-Headers, which is strictly MORE permissive than
 *     the list that was intended. Correcting the spelling tightens the policy.
 *
 * Correcting only the spelling would be a security regression, not a fix:
 * `origin: true` reflects any requesting origin, and combined with a working
 * `credentials: true` that would let any site on the internet make credentialed
 * requests with a victim's ambient authority. Because nothing exercises the
 * cross-origin path today, no test would fail. So the allowlist lands in the
 * same change as the spelling fix, never after it.
 *
 * The policy is split by request kind, because p3_api is a *public* data API
 * and a blanket allowlist would break legitimate anonymous consumers:
 *
 *   - Anonymous cross-origin reads stay open to any origin. This is the
 *     documented public-API behavior and there is no authority to steal.
 *   - Credentialed requests (ACAC: true) are granted only to origins on the
 *     allowlist -- the BV-BRC web properties.
 *
 * Note that p3_api has no cookie or session authentication: middleware/auth.js
 * reads the Authorization header and nothing else. cookie-parser is registered
 * in app.js but req.cookies is never read. So a cross-origin attacker has no
 * ambient authority to ride even before the allowlist -- the allowlist exists
 * to keep that true as the OAuth2 migration introduces cookie-backed sessions
 * in the website BFF.
 *
 * The allowlist comes from config (`cors_origins`), never from interpolation
 * over a property name. BV-BRC uses alpha./beta./dev-N. while DXKB, LDKB and
 * MAAGE use dev./test., so no naming convention covers all four properties.
 * This is the same enumeration the OAuth2 redirect_uri registration needs and
 * the two must be kept in sync -- see PLAN-oauth2-migration.md, "Multi-Domain
 * Rollout and CORS".
 *
 * Headers: the allowedHeaders list must cover everything a browser client
 * sends, since a header omitted here now fails preflight rather than being
 * reflected. See the note on ALLOWED_HEADERS below for how the list was
 * checked against both the p3 client and p3_api's own reads.
 *
 * cors is pinned at 2.5.3 here, which does NOT support an array `origin` --
 * it handles only `true`, a string, or a function. Hence the delegate form.
 */

/*
 * The first six are unchanged from the previous configuration. p3_api also
 * reads x-request-id and x-forwarded-for, but both are set by the upstream
 * proxy rather than by a browser, and proxy-set headers are not subject to
 * preflight -- adding them would widen the policy for no caller.
 *
 * x-requested-with is NOT optional, even though no server code reads it.
 * dojo/request/xhr.js:278 sends it by DEFAULT:
 *
 *     if(!headers || !('X-Requested-With' in headers)){
 *       _xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
 *     }
 *
 * It is suppressed only where a call site explicitly passes the key with a
 * falsy value. Many p3 sites do exactly that -- which is what makes the header
 * easy to dismiss -- but any site that omits the key entirely still sends it.
 * Most p3_api traffic is same-origin via the relative dataServiceURL and so
 * never preflights, but not all of it: PriorityPathogen.js:418 fetches the
 * absolute https://www.bv-brc.org/api/... and passes only an `accept` header,
 * so it sends X-Requested-With cross-origin from every non-production
 * property.
 *
 * Under the old `allowHeaders` typo cors reflected Access-Control-Request-
 * Headers, so this was allowed by accident. Omitting it from the fixed list
 * fails preflight with "Request header field X-Requested-With is not allowed
 * by Access-Control-Allow-Headers" -- which is exactly how this was found, on
 * p3_user, in production.
 *
 * Do not remove it on the grounds that nothing reads it server-side. The
 * question for this list is what the CLIENT SENDS, not what the server
 * consumes -- a header omitted here fails preflight before any handler runs.
 */
var ALLOWED_HEADERS = [
  'if-none-match',
  'range',
  'accept',
  'x-range',
  'content-type',
  'authorization',
  'x-requested-with'
]

var EXPOSED_HEADERS = [
  'facet_counts',
  'x-facet-count',
  'Content-Range',
  'X-Content-Range',
  'X-Cursor-Mark',
  'ETag'
]

/*
 * Deliberately unchanged from the previous configuration, which passed
 * ['GET,POST,PUT,DELETE'] -- a single-element array that cors joins to the
 * same string. There is a router.patch route (routes/dataType.js:131), but it
 * is paired with an identical POST route "for clients that cannot issue the
 * patch http verb", so browsers already take the POST path. Adding PATCH here
 * would widen the policy for no caller, which is not this change's business.
 */
var METHODS = ['GET', 'POST', 'PUT', 'DELETE']

var MAX_AGE = 86400

/*
 * Exact string match on the serialized origin. No wildcards, no suffix
 * matching: a suffix test for '.bv-brc.org' would also match
 * 'evil-bv-brc.org' and 'bv-brc.org.attacker.net'.
 */
function isAllowed (origin, allowlist) {
  return Boolean(origin) && allowlist.indexOf(origin) !== -1
}

/*
 * Returns a cors options delegate. Reads the allowlist once at startup; the
 * service is restarted on config change, as documented for every other
 * p3api.conf value.
 */
function corsOptionsDelegate (config) {
  var allowlist = config.get('cors_origins') || []

  if (!Array.isArray(allowlist)) {
    throw new Error('cors_origins must be an array of exact origin strings')
  }

  return function (req, callback) {
    var origin = req.headers.origin

    callback(null, {
      // Reflect the origin so credentialed responses are valid: ACAO cannot
      // be '*' when ACAC is true. For non-allowlisted origins this still
      // reflects, which keeps anonymous public access working -- but
      // credentials stays false, so the browser drops any credentialed
      // response.
      origin: true,
      credentials: isAllowed(origin, allowlist),
      methods: METHODS,
      allowedHeaders: ALLOWED_HEADERS,
      exposedHeaders: EXPOSED_HEADERS,
      maxAge: MAX_AGE
    })
  }
}

module.exports = corsOptionsDelegate
module.exports.isAllowed = isAllowed
module.exports.ALLOWED_HEADERS = ALLOWED_HEADERS
module.exports.EXPOSED_HEADERS = EXPOSED_HEADERS
module.exports.METHODS = METHODS
