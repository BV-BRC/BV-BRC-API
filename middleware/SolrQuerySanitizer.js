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
 * Sanitize a query string by removing dangerous parameters
 * @param {string} queryString - The query string to sanitize
 * @returns {object} - Object with sanitized query and list of blocked params
 */
function sanitizeQueryString (queryString) {
  if (!queryString || typeof queryString !== 'string') {
    return { sanitized: queryString, blockedParams: [] }
  }

  const blockedParams = []
  const parts = queryString.split('&')
  const safeParts = []

  for (const part of parts) {
    // Handle both key=value and just key
    const eqIndex = part.indexOf('=')
    const paramName = eqIndex >= 0 ? part.substring(0, eqIndex) : part

    // Decode the parameter name to catch encoded attacks
    let decodedParamName
    try {
      decodedParamName = decodeURIComponent(paramName)
    } catch (e) {
      // If decoding fails, use the original
      decodedParamName = paramName
    }

    if (isDangerousParam(decodedParamName)) {
      blockedParams.push(decodedParamName)
      debug(`Blocked dangerous parameter: ${decodedParamName}`)
    } else {
      safeParts.push(part)
    }
  }

  return {
    sanitized: safeParts.join('&'),
    blockedParams
  }
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
    // Decode the key to catch encoded attacks
    let decodedKey
    try {
      decodedKey = decodeURIComponent(key)
    } catch (e) {
      decodedKey = key
    }

    if (isDangerousParam(decodedKey)) {
      blockedParams.push(decodedKey)
      debug(`Blocked dangerous parameter: ${decodedKey}`)
    } else {
      sanitized[key] = value
    }
  }

  return { sanitized, blockedParams }
}

/**
 * Express middleware to sanitize Solr queries
 */
module.exports = function SolrQuerySanitizer (req, res, next) {
  let allBlockedParams = []

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

  // Log security events
  if (allBlockedParams.length > 0) {
    const uniqueBlocked = [...new Set(allBlockedParams)]
    console.log(`[SECURITY] Blocked dangerous Solr params: ${uniqueBlocked.join(', ')} from ${req.ip || req.connection.remoteAddress}`)
  }

  next()
}

// Export helpers for testing
module.exports.isDangerousParam = isDangerousParam
module.exports.sanitizeQueryString = sanitizeQueryString
module.exports.sanitizeParamsObject = sanitizeParamsObject
module.exports.DANGEROUS_PARAMS = DANGEROUS_PARAMS
