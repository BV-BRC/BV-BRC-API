/**
 * Permission Filter
 *
 * Single source of truth for the Solr permission filter query (`fq`) that scopes
 * a request to the rows a given user is entitled to see.
 *
 * Historically this logic was inlined in middleware/DecorateQuery.js and applied
 * only to the *primary* query. Join enrichment performs *secondary* fetches
 * (BatchJoiner / DirectSolrClient / the join streams) which bypassed it entirely.
 * Both paths now call through here so the semantics cannot drift apart.
 *
 * See PLAN_ENRICHMENT_PERMISSIONS.md.
 *
 * `publicOwners` (p3api.conf): rows owned by any listed account are treated as public
 * — visible to anonymous and authenticated callers alike, in every filter built here
 * and in the per-document check `isDocVisible`. Read access only; write access
 * (middleware/patch.js) is unaffected.
 *
 * Cache scoping is deliberately unchanged: these rows are visible under EVERY scope,
 * so sharing them through the `public` cache partition cannot leak anything.
 */

const Config = require('../config')

/**
 * Normalize a publicOwners setting to a de-duplicated array of non-empty strings.
 * Accepts an array or a comma-separated string (the latter is what an env var gives).
 *
 * @param {Array<string>|string|null|undefined} value
 * @returns {Array<string>}
 */
function normalizeOwners (value) {
  if (value == null || value === '') return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = []
  for (const v of list) {
    if (typeof v !== 'string') {
      throw new Error(`publicOwners: expected strings, got ${JSON.stringify(v)}`)
    }
    const t = v.trim()
    if (t && out.indexOf(t) < 0) out.push(t)
  }
  return out
}

// Read once at load; the setting is static for the life of the process. A malformed
// value fails the process at startup rather than silently filtering wrongly.
const CONFIGURED_PUBLIC_OWNERS = normalizeOwners(Config.get('publicOwners'))

function resolveOwners (publicOwners) {
  return publicOwners === undefined ? CONFIGURED_PUBLIC_OWNERS : normalizeOwners(publicOwners)
}

/**
 * Escape a value for safe interpolation into a Solr query clause.
 *
 * User ids reaching this point are token-validated (middleware/auth.js), so this
 * is defense in depth rather than the primary control — but this helper is the
 * one place a user-supplied value gets interpolated into an `fq`, so the escaping
 * belongs here.
 *
 * @param {string} value - Value to escape
 * @returns {string} Escaped value
 */
function escapeSolrValue (value) {
  return String(value).replace(/([+\-!(){}[\]^"~*?:\\/&|])/g, '\\$1')
}

/**
 * Determine whether a collection is exempt from permission filtering.
 *
 * @param {string} collection - Collection name
 * @param {Array<string>} [publicFree] - Allowlist of permission-exempt collections
 * @returns {boolean} True if the collection needs no permission filter
 */
function isPublicFree (collection, publicFree) {
  return Array.isArray(publicFree) && publicFree.indexOf(collection) >= 0
}

/**
 * Build the permission filter query for a collection + user.
 *
 * Reproduces DecorateQuery's semantics exactly:
 *   - collection in publicFree  → null (no filter needed)
 *   - no user                   → `public:true`
 *   - user present              → `(public:true OR owner:<user> OR user_read:<user>)`
 *
 * With publicOwners configured, `public:true` is widened to
 * `(public:true OR owner:<o1> OR owner:<o2> ...)` in both forms.
 *
 * @param {Object} opts
 * @param {string} opts.collection - Collection being queried/fetched
 * @param {string} [opts.user] - Authenticated user id, if any
 * @param {Array<string>} [opts.publicFree] - Permission-exempt collection allowlist
 * @param {Array<string>|string} [opts.publicOwners] - Override for the configured
 *   publicOwners (tests); omit to use p3api.conf
 * @returns {string|null} The fq string, or null when no filter is required
 */
function buildPermissionFq ({ collection, user, publicFree, publicOwners }) {
  if (isPublicFree(collection, publicFree)) {
    return null
  }

  const ownerClauses = resolveOwners(publicOwners).map((o) => `owner:${escapeSolrValue(o)}`)
  const publicTerms = ['public:true', ...ownerClauses]

  if (!user) {
    return publicTerms.length === 1 ? 'public:true' : `(${publicTerms.join(' OR ')})`
  }

  const u = escapeSolrValue(user)
  return `(${publicTerms.join(' OR ')} OR owner:${u} OR user_read:${u})`
}

/**
 * Per-document counterpart of buildPermissionFq, for paths that fetch by id
 * (Solr real-time get) and must check visibility after the fact.
 *
 * @param {Object} doc - Solr document (needs public/owner/user_read)
 * @param {Object} opts - Same shape as buildPermissionFq
 * @returns {boolean}
 */
function isDocVisible (doc, { collection, user, publicFree, publicOwners }) {
  if (!doc) return false
  if (isPublicFree(collection, publicFree)) return true
  if (doc.public) return true
  if (doc.owner && resolveOwners(publicOwners).indexOf(doc.owner) >= 0) return true
  // Preserved verbatim from the inline check this replaced in APIMethodHandler,
  // including its quirk: an anonymous caller matches a doc with NO owner field
  // (undefined === undefined). Changing that is a separate decision.
  return doc.owner === user || (!!doc.user_read && doc.user_read.indexOf(user) >= 0)
}

/**
 * Build a stable key identifying the *permission view* a fetch was made under.
 *
 * Used to scope cache entries so a row fetched while serving one user can never
 * be served to another. Rows fetched under an exempt or anonymous scope share the
 * `public` key, preserving cache hit-rate for the common case.
 *
 * @param {Object} opts
 * @param {string} opts.collection - Collection being fetched
 * @param {string} [opts.user] - Authenticated user id, if any
 * @param {Array<string>} [opts.publicFree] - Permission-exempt collection allowlist
 * @returns {string} Scope key (`public` or `user:<user>`)
 */
function permissionScopeKey ({ collection, user, publicFree }) {
  // Exempt collections return identical rows regardless of who asks, so all
  // users share one scope. Same for anonymous requests (public rows only).
  if (isPublicFree(collection, publicFree) || !user) {
    return 'public'
  }

  return `user:${user}`
}

/**
 * Convenience: build both the fq and the matching scope key in one call.
 * Callers that fetch-then-cache need both and must derive them from the same
 * inputs — getting these out of sync is the failure mode this guards against.
 *
 * @param {Object} opts - Same shape as buildPermissionFq
 * @returns {{ permissionFq: string|null, scopeKey: string }}
 */
function permissionContext (opts) {
  return {
    permissionFq: buildPermissionFq(opts),
    scopeKey: permissionScopeKey(opts)
  }
}

module.exports = {
  buildPermissionFq,
  permissionScopeKey,
  permissionContext,
  isDocVisible,
  normalizeOwners,
  escapeSolrValue
}
