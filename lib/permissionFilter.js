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
 */

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
 * @param {Object} opts
 * @param {string} opts.collection - Collection being queried/fetched
 * @param {string} [opts.user] - Authenticated user id, if any
 * @param {Array<string>} [opts.publicFree] - Permission-exempt collection allowlist
 * @returns {string|null} The fq string, or null when no filter is required
 */
function buildPermissionFq ({ collection, user, publicFree }) {
  if (isPublicFree(collection, publicFree)) {
    return null
  }

  if (!user) {
    return 'public:true'
  }

  const u = escapeSolrValue(user)
  return `(public:true OR owner:${u} OR user_read:${u})`
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
  escapeSolrValue
}
