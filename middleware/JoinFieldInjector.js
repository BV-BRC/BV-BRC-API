/**
 * JoinFieldInjector Middleware
 *
 * Injects join key fields (e.g., genome_id) into the Solr field list (fl=)
 * when joinable fields are requested. This ensures the join key is available
 * for the post-query JoinEnrichment middleware.
 *
 * This middleware must run BEFORE APIMethodHandler in the middleware chain.
 */

const debug = require('debug')('p3api-server:middleware/JoinFieldInjector')
const { getRequestedJoinFields } = require('../lib/parseFieldList')
const { getJoinConfig, buildJoinSpecs, getRequiredJoinKeys } = require('../lib/joinConfig')

/**
 * Inject join key fields into the Solr query's field list.
 *
 * @param {string} query - Solr query string
 * @param {Set<string>} keysToInject - Join key fields to add
 * @returns {string} Modified query string with injected fields
 */
function injectFieldsIntoQuery (query, keysToInject) {
  if (keysToInject.size === 0) {
    return query
  }

  // Match fl= parameter
  const flMatch = query.match(/([&?]fl=)([^&]*)/)

  if (!flMatch) {
    // No fl= parameter means all fields are returned, no injection needed
    return query
  }

  const flPrefix = flMatch[1] // "&fl=" or "?fl="
  const flValue = flMatch[2]  // The field list value

  // Decode and parse existing fields
  const decodedValue = decodeURIComponent(flValue.replace(/\+/g, ' ')).trim()

  // If fl=* then all fields are returned, no injection needed
  if (decodedValue === '*' || decodedValue === '') {
    return query
  }

  // Parse existing fields
  const existingFields = new Set(
    decodedValue.split(',').map(f => f.trim()).filter(f => f.length > 0)
  )

  // Add missing join key fields
  let modified = false
  for (const key of keysToInject) {
    if (!existingFields.has(key)) {
      existingFields.add(key)
      modified = true
      debug(`Injecting join key field: ${key}`)
    }
  }

  if (!modified) {
    return query
  }

  // Rebuild the fl= parameter
  const newFlValue = Array.from(existingFields).join(',')
  const newFlParam = flPrefix + encodeURIComponent(newFlValue)

  // Replace the old fl= with the new one
  return query.replace(/([&?]fl=)[^&]*/, newFlParam)
}

/**
 * JoinFieldInjector Middleware
 *
 * Modifies the query to include join key fields when joinable fields are requested.
 * Also stores join specifications on the request object for downstream middleware
 * (JoinEnrichment for paginated queries, JoinEnrichmentStream for streaming).
 */
function joinFieldInjectorMiddleware (req, res, next) {
  // Only process query methods (both paginated and streaming)
  if (req.call_method !== 'query') {
    return next()
  }

  // Get join configuration
  const config = getJoinConfig()

  // Check if join enrichment is enabled
  if (!config.enabled) {
    return next()
  }

  // Get collection-specific config
  const collectionConfig = config.collections[req.call_collection]
  if (!collectionConfig || !collectionConfig.joinableFields) {
    return next()
  }

  // Parse requested fields from the query
  const query = req.call_params[0] || ''
  const requestedJoinFields = getRequestedJoinFields(query, collectionConfig.joinableFields)

  if (requestedJoinFields.length === 0) {
    return next()
  }

  // Build join specs and store on request for downstream middleware
  const joinSpecs = buildJoinSpecs(requestedJoinFields, collectionConfig.joinableFields)
  if (joinSpecs.length > 0) {
    req._joinSpecs = joinSpecs
    debug(`Join specs prepared for ${req.call_collection}: ${joinSpecs.map(s => s.fields.join(',')).join('; ')}`)
  }

  // Get the join key fields we need to inject
  const requiredKeys = getRequiredJoinKeys(requestedJoinFields, collectionConfig.joinableFields)

  if (requiredKeys.size === 0) {
    return next()
  }

  // Inject the join key fields into the query
  const modifiedQuery = injectFieldsIntoQuery(query, requiredKeys)

  if (modifiedQuery !== query) {
    debug(`Modified query to include join keys: ${Array.from(requiredKeys).join(',')}`)
    req.call_params[0] = modifiedQuery

    // Store the injected fields so JoinEnrichment can remove them from output if needed
    req._injectedJoinKeys = requiredKeys
  }

  next()
}

module.exports = joinFieldInjectorMiddleware
module.exports.getJoinConfig = getJoinConfig
module.exports.getRequiredJoinKeys = getRequiredJoinKeys
module.exports.injectFieldsIntoQuery = injectFieldsIntoQuery
