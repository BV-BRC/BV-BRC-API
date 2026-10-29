/**
 * SolrQuerySanitizer Middleware
 *
 * Security middleware to prevent SSRF and other attacks via Solr query parameters.
 * Strips dangerous parameters from Solr queries before they reach the Solr server.
 *
 * Addresses vulnerabilities:
 * - TIKI-W094-6: Arbitrary Solr Queries lead to Full read SSRF
 * - TIKI-W094-7: Solr Query Injection on regionFeatureDensities
 * - TIKI-W094-8: SSRF in multi query endpoint via Solr Injection
 * - TIKI-W094-9: Solr Query Injection via annotation on region
 */

const debug = require('debug')('p3api-server:SolrQuerySanitizer')

// Dangerous Solr parameters that must be blocked
// These can be used for SSRF, file access, or information disclosure
const DANGEROUS_PARAMS = [
  // SSRF via shard redirection - can redirect queries to arbitrary internal hosts
  'shards',

  // Stream parameters - can access arbitrary URLs or files
  'stream.url',
  'stream.file',
  'stream.body',

  // Request handler override - can invoke arbitrary handlers
  'qt',

  // Information disclosure
  'debug',
  'debugquery',
  'echoparams',

  // Collection/routing manipulation
  'collection',
  '_route_'
]

// Pattern to match shards.* parameters (e.g., shards.qt, shards.info, etc.)
const SHARDS_PREFIX_PATTERN = /^shards\./i

// ---------------------------------------------------------------------------
// ACL fields may not be used as AGGREGATION targets.
//
// Permission enforcement in this codebase is row-level only: DecorateQuery appends an fq
// deciding which documents you see, and nothing decides which FIELDS of a visible
// document you may read, facet, or sort on. `owner`/`user_read`/`user_write` are ordinary
// indexed fields, so on any record shared with you, you can read its full ACL.
//
// Faceting turns that from per-record visibility into BULK ENUMERATION, because facet
// counts are computed over the whole permission-filtered DocSet rather than the returned
// page. Measured anonymously against alpha, no credentials:
//
//   eq(public,false)&limit(1)&facet((field,user_read),(mincount,0))
//     -> 100 account names (the default facet limit; facet.limit=-1 yields 30,513)
//
// A ranked facet over `user_read` is also a collaborator graph — who shares with whom,
// ordered by how much.
//
// This blocks the AGGREGATE vector only. Per-record ACL visibility and the targeted
// `eq(user_read,<user>)` existence oracle remain; closing those is field-level projection
// filtering, a new concern for this codebase (Option B in
// Docs/SECURITY-acl-field-disclosure.md). Option A — this — is what removes the part
// that scales.
//
// Deliberately blocked for EVERYONE rather than for non-owners. Ownership is per record
// and a facet spans records, so there is no requester for whom an aggregate over these
// fields is well-defined.
const ACL_FIELDS = ['owner', 'user_read', 'user_write']

// Parameters whose VALUE names a field to aggregate, sort, or group by. These are the
// routes by which a field name reaches Solr as something other than a filter term.
//
// Note `fl` is absent on purpose: projecting an ACL field returns it only for rows the
// requester can already see, which is the per-record visibility this does not address.
// Adding it here would break owners legitimately reading their own ACLs.
const FIELD_NAMING_PARAMS = [
  'facet.field',
  'facet.pivot',
  'facet.range',
  'facet.interval',
  'group.field',
  'sort',
  'stats.field'
]

// A field reference inside a parameter value. Values are lists or decorated:
//   facet.pivot=owner,user_read        (comma-separated pivot chain)
//   sort=user_read asc,genome_id desc  (comma-separated, each "field direction")
//   facet.field={!ex=dt}owner          (local param prefix)
// so matching the bare name against the whole value would both over- and under-match.
const ACL_FIELD_IN_VALUE = new RegExp(
  '(^|[,\\s{}!=])(' + ACL_FIELDS.join('|') + ')($|[,\\s}])', 'i'
)

/**
 * Does this parameter name a field to aggregate/sort/group by?
 * Case-insensitive, matching how the rest of this module treats parameter names.
 */
function isFieldNamingParam (paramName) {
  if (!paramName || typeof paramName !== 'string') return false
  return FIELD_NAMING_PARAMS.includes(paramName.trim().toLowerCase())
}

/**
 * Is an ACL field used as an aggregation target anywhere in this query string?
 *
 * Scans the fully-decoded form as well as the raw one, so an encoded
 * `facet.field=%75ser_read` cannot slip past — consistent with how dangerous parameter
 * names are handled above.
 *
 * @param {string} queryString
 * @returns {string|null} the offending "param=value" pair, or null
 */
function findAclAggregation (queryString) {
  if (!queryString || typeof queryString !== 'string') return null

  for (const text of [queryString, fullyDecode(queryString)]) {
    for (const pair of text.split('&')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq)
      if (!isFieldNamingParam(name)) continue
      // Decode the value independently: the pair may be raw while the value is encoded.
      const value = fullyDecode(pair.slice(eq + 1))
      if (ACL_FIELD_IN_VALUE.test(value)) {
        return `${name.trim().toLowerCase()}=${value}`
      }
    }
  }
  return null
}

/**
 * Fully decode a string by repeatedly applying decodeURIComponent
 * until no further decoding is possible. This catches double, triple,
 * and deeper encoding used to bypass sanitization.
 * @param {string} str - The string to decode
 * @returns {string} - Fully decoded string
 */
function fullyDecode (str) {
  if (!str) return str
  let prev = str
  for (let i = 0; i < 10; i++) {
    try {
      var decoded = decodeURIComponent(prev)
    } catch (e) {
      return prev
    }
    if (decoded === prev) return decoded
    prev = decoded
  }
  return prev
}

/**
 * Check if a parameter name is dangerous
 * @param {string} paramName - The parameter name to check
 * @returns {boolean} - True if the parameter is dangerous
 */
function isDangerousParam (paramName) {
  const lowerName = paramName.toLowerCase()

  // Check exact matches
  if (DANGEROUS_PARAMS.includes(lowerName)) {
    return true
  }

  // Check shards.* pattern
  if (SHARDS_PREFIX_PATTERN.test(paramName)) {
    return true
  }

  return false
}

/**
 * Sanitize a query string by removing dangerous parameters.
 * Fully decodes the entire string first to catch multi-level encoding
 * attacks (double, triple, etc.), then rejects the ENTIRE query if any
 * dangerous parameter is found in the decoded form. This prevents
 * smuggling via encoded & characters (%26, %2526, etc.).
 * @param {string} queryString - The query string to sanitize
 * @returns {object} - Object with sanitized query and list of blocked params
 */
function sanitizeQueryString (queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return { sanitized: queryString, blockedParams: [] }
  }

  // Fully decode the entire string to catch all encoding levels,
  // then check for dangerous params in the decoded version.
  // If ANY dangerous param is found anywhere in the fully-decoded
  // string, reject the entire query — encoding tricks mean the
  // whole request is malicious.
  const fullyDecoded = fullyDecode(queryString)
  const smuggled = findDangerousParamsInString(fullyDecoded)
  if (smuggled.length > 0) {
    debug(`Blocked entire query — dangerous params found after full decode: ${smuggled.join(', ')}`)
    return { sanitized: '', blockedParams: smuggled }
  }

  // No encoded tricks detected. Do the standard per-part scan on the
  // raw query string as a second layer (handles plain-text params).
  const blockedParams = []
  const parts = queryString.split('&')
  const safeParts = []

  for (const part of parts) {
    const eqIndex = part.indexOf('=')
    const paramName = eqIndex >= 0 ? part.substring(0, eqIndex) : part

    if (isDangerousParam(paramName.trim())) {
      blockedParams.push(paramName.trim())
      debug(`Blocked dangerous parameter: ${paramName.trim()}`)
      continue
    }

    safeParts.push(part)
  }

  return {
    sanitized: safeParts.join('&'),
    blockedParams
  }
}

/**
 * Scan a string for dangerous parameter names by splitting on & and
 * checking each segment as a potential param=value pair.
 * @param {string} str - The string to scan
 * @returns {Array<string>} - Dangerous param names found
 */
function findDangerousParamsInString (str) {
  if (!str) return []
  const found = []
  const parts = str.split('&')
  for (const part of parts) {
    const eqIndex = part.indexOf('=')
    const paramName = eqIndex >= 0 ? part.substring(0, eqIndex) : part
    if (isDangerousParam(paramName.trim())) {
      found.push(paramName.trim())
    }
  }
  return found
}

/**
 * Sanitize an object of parameters by removing dangerous keys
 * @param {object} params - The parameters object to sanitize
 * @returns {object} - Object with sanitized params and list of blocked params
 */
function sanitizeParamsObject (params) {
  if (!params || typeof params !== 'object') {
    return { sanitized: params, blockedParams: [] }
  }

  const blockedParams = []
  const sanitized = {}

  for (const [key, value] of Object.entries(params)) {
    const decodedKey = fullyDecode(key)

    if (isDangerousParam(decodedKey)) {
      blockedParams.push(decodedKey)
      debug(`Blocked dangerous parameter: ${decodedKey}`)
    } else if (typeof value === 'string') {
      // Check if the value contains smuggled dangerous params
      const decodedValue = fullyDecode(value)
      const smuggled = findDangerousParamsInString(decodedValue)
      if (smuggled.length > 0) {
        blockedParams.push(...smuggled)
        debug(`Blocked smuggled params in value of ${decodedKey}: ${smuggled.join(', ')}`)
      } else {
        sanitized[key] = value
      }
    } else {
      sanitized[key] = value
    }
  }

  return { sanitized, blockedParams }
}

// Matches a Solr join local param in a filter *value*, in any of its spellings.
//
// Unlike everything else this module blocks, {!join} is not a parameter name — it is a
// local-param block inside an fq value, so isDangerousParam() cannot see it and adding
// 'join' to DANGEROUS_PARAMS would do nothing.
const JOIN_LOCALPARAM_PATTERN = /\{!\s*join\b/i

// The one join shape this codebase generates. Both sites — lib/solrjs/rql.js (the RQL
// genome() clause) and routes/dataRouter.js (summary_by_taxon) — emit exactly this, and
// JoinResolution counts and gates them. Anything else is not ours.
const OUR_JOIN_PATTERN = /\{!\s*join\s+method=crossCollection\s+fromIndex=genome\b/i

/**
 * Does a query contain a join this codebase would never generate?
 *
 * Defense in depth against the OOM class: a client-written join — a different fromIndex,
 * a non-crossCollection join, a nested subquery — is unreviewed and unbounded, and a
 * broad one is the shape that crashed three data nodes on 2026-06-25.
 *
 * A client-submitted join that happens to match our own form is deliberately NOT caught
 * here. It cannot be distinguished from a generated one at this point in the chain, and
 * it does not need to be: JoinResolution counts its genome set downstream and refuses it
 * if it is too broad. Trying to tell them apart from request metadata is exactly the
 * mistake that broke every genome() query on alpha.
 *
 * @param {string} queryString
 * @returns {boolean}
 */
function containsForeignJoin (queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return false
  }
  // Decode first so an encoded %7B!join cannot slip past, consistent with how dangerous
  // parameter names are handled above.
  const candidates = [queryString, fullyDecode(queryString)]
  for (const text of candidates) {
    if (!JOIN_LOCALPARAM_PATTERN.test(text)) {
      continue
    }
    // A join is present. Allow it only if every join in the string is our own shape.
    const joins = text.match(/\{!\s*join\b[^}]*\}/gi) || []
    for (const join of joins) {
      if (!OUR_JOIN_PATTERN.test(join)) {
        return true
      }
    }
  }
  return false
}

/**
 * Express middleware to sanitize Solr queries
 */
module.exports = function SolrQuerySanitizer (req, res, next) {
  let allBlockedParams = []

  // Block a join the CLIENT wrote, without touching the API's own.
  //
  // ORDERING IS LOAD-BEARING, and getting this wrong is not a subtle failure — it broke
  // every genome() RQL query on alpha for the length of one deploy.
  //
  // This middleware runs AFTER RQLQueryParser, so by now call_params may already hold
  // the {!join ...} that rql.js generated for an RQL genome() clause. An earlier version
  // keyed off `req.queryType === 'solr'` to decide whether call_params was client-written.
  // It is not: queryType is set from the request's content-type
  // (routes/dataType.js:108,216), and `application/solrquery+...` is simply how the
  // website sends RQL-derived queries too. So a perfectly ordinary
  // `genome(eq(taxon_lineage_ids,N))` was rejected with "prohibited join" — observed live
  // on alpha against both a 7-genome taxon and a 327K one.
  //
  // The reliable discriminator is the JOIN ITSELF, not the request metadata. Every join
  // this codebase generates is `method=crossCollection fromIndex=genome` (lib/solrjs/rql.js
  // and routes/dataRouter.js are the only two sites, and JoinResolution handles those).
  // Anything else in a {!join} is a client's own construction, and that is what gets
  // refused here. A client-submitted crossCollection join to genome is indistinguishable
  // from ours at this point, so it is allowed through — and lands in JoinResolution, which
  // counts its genome set and rejects it if it is too broad. Same protection, by a
  // different gate.
  const query = req.call_params && req.call_params[0]

  if (containsForeignJoin(query)) {
    console.log(`[SECURITY] Blocked client-supplied Solr join from ${req.ip || (req.connection && req.connection.remoteAddress)}`)
    return res.status(400).json({ error: 'Request contains a prohibited join; use the genome() RQL operator instead' })
  }

  // Block aggregation over ACL fields — see ACL_FIELDS above for the measured vector.
  //
  // Checked against call_params (post-RQLQueryParser, so an RQL facet() has already
  // become facet.field=) AND against the raw body, which is what a client sending
  // Solr-format queries supplies directly. RQLQueryParser returns early for
  // queryType === 'solr', so the body is the only place that form is visible.
  const aclTargets = [query, typeof req.body === 'string' ? req.body : null]
  for (const candidate of aclTargets) {
    const offending = findAclAggregation(candidate)
    if (offending) {
      console.log(`[SECURITY] Blocked ACL-field aggregation (${offending}) from ${req.ip || (req.connection && req.connection.remoteAddress)}`)
      return res.status(400).json({
        error: 'Faceting, sorting, or grouping on owner/user_read/user_write is not permitted'
      })
    }
  }

  // Sanitize call_params (the main query parameters)
  if (req.call_params && req.call_params.length > 0 && typeof req.call_params[0] === 'string') {
    const result = sanitizeQueryString(req.call_params[0])
    req.call_params[0] = result.sanitized
    allBlockedParams = allBlockedParams.concat(result.blockedParams)
  }

  // Also check req.body if it's a string (for POST requests with form data)
  if (typeof req.body === 'string') {
    const result = sanitizeQueryString(req.body)
    req.body = result.sanitized
    allBlockedParams = allBlockedParams.concat(result.blockedParams)
  }

  // Check req.body if it's an object
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const result = sanitizeParamsObject(req.body)
    req.body = result.sanitized
    allBlockedParams = allBlockedParams.concat(result.blockedParams)
  }

  // Check URL query string (req.query from express)
  if (req.query && typeof req.query === 'object') {
    const result = sanitizeParamsObject(req.query)
    // Note: We don't modify req.query directly as it may cause issues
    // The main protection is via call_params sanitization
    allBlockedParams = allBlockedParams.concat(result.blockedParams)
  }

  // Hard reject if dangerous params were detected
  if (allBlockedParams.length > 0) {
    const uniqueBlocked = [...new Set(allBlockedParams)]
    console.log(`[SECURITY] Blocked dangerous Solr params: ${uniqueBlocked.join(', ')} from ${req.ip || req.connection.remoteAddress}`)
    return res.status(400).json({ error: 'Request contains prohibited query parameters' })
  }

  next()
}

// Export helpers for testing
module.exports.isDangerousParam = isDangerousParam
module.exports.sanitizeQueryString = sanitizeQueryString
module.exports.sanitizeParamsObject = sanitizeParamsObject
module.exports.DANGEROUS_PARAMS = DANGEROUS_PARAMS
module.exports.containsForeignJoin = containsForeignJoin
module.exports.findAclAggregation = findAclAggregation
module.exports.ACL_FIELDS = ACL_FIELDS
module.exports.FIELD_NAMING_PARAMS = FIELD_NAMING_PARAMS
