/**
 * parseFieldList - Utility to parse field lists from Solr query strings
 *
 * Extracts the field list (fl parameter) from a Solr query string.
 * Handles both direct fl= parameter and the result of RQL select() conversion.
 */

const debug = require('debug')('p3api-server:parse-field-list')

/**
 * Parse field list from Solr query string.
 *
 * @param {string} query - Solr query string (e.g., '&q=*:*&fl=field1,field2&rows=10')
 * @returns {Set<string>|null} Set of field names, or null if all fields requested
 *
 * @example
 * parseFieldList('&q=*:*&fl=genome_id,genome_name,product&rows=10')
 * // Returns: Set { 'genome_id', 'genome_name', 'product' }
 *
 * @example
 * parseFieldList('&q=*:*&rows=10')
 * // Returns: null (no fl= means all fields)
 *
 * @example
 * parseFieldList('&q=*:*&fl=*&rows=10')
 * // Returns: null (fl=* means all fields)
 */
function parseFieldList (query) {
  if (!query || typeof query !== 'string') {
    debug('No query string provided, returning null')
    return null
  }

  // Match fl= parameter
  // Pattern handles: fl=field1,field2 or &fl=field1,field2
  const flMatch = query.match(/(?:^|[&?])fl=([^&]*)/)

  if (!flMatch) {
    debug('No fl= parameter found, returning null')
    return null
  }

  const flValue = flMatch[1]

  // Decode URL-encoded values and normalize spaces
  const decodedValue = decodeURIComponent(flValue.replace(/\+/g, ' ')).trim()

  // fl=* means all fields
  if (decodedValue === '*' || decodedValue === '') {
    debug('fl=* or empty, returning null')
    return null
  }

  // Split by comma and clean up
  const fields = decodedValue
    .split(',')
    .map(f => f.trim())
    .filter(f => f.length > 0 && f !== '*')

  if (fields.length === 0) {
    debug('No valid fields found, returning null')
    return null
  }

  debug(`Parsed fields: ${fields.join(', ')}`)
  return new Set(fields)
}

/**
 * Check if a specific field is requested in the query.
 *
 * @param {string} query - Solr query string
 * @param {string} fieldName - Field name to check
 * @returns {boolean} True if field is requested (or all fields are requested)
 */
function isFieldRequested (query, fieldName) {
  const fields = parseFieldList(query)

  // null means all fields, so the field is implicitly requested
  if (fields === null) {
    return true
  }

  return fields.has(fieldName)
}

/**
 * Get the intersection of requested fields and available joinable fields.
 *
 * @param {string} query - Solr query string
 * @param {Object} joinableFields - Map of field names to join specifications
 * @returns {Array<string>} Array of joinable field names that were requested
 *
 * @example
 * const joinableFields = {
 *   genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
 *   taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
 * }
 * getRequestedJoinFields('&q=*:*&fl=patric_id,genome_name,product', joinableFields)
 * // Returns: ['genome_name']
 */
function getRequestedJoinFields (query, joinableFields) {
  if (!joinableFields || typeof joinableFields !== 'object') {
    return []
  }

  const requestedFields = parseFieldList(query)

  // If no fl= specified (all fields), we should NOT perform joins
  // because the user didn't explicitly request join fields
  // This prevents unexpected performance overhead
  if (requestedFields === null) {
    debug('No explicit field list, skipping joins')
    return []
  }

  const joinableFieldNames = Object.keys(joinableFields)
  const requested = joinableFieldNames.filter(field => requestedFields.has(field))

  debug(`Requested join fields: ${requested.join(', ') || '(none)'}`)
  return requested
}

module.exports = parseFieldList
module.exports.parseFieldList = parseFieldList
module.exports.isFieldRequested = isFieldRequested
module.exports.getRequestedJoinFields = getRequestedJoinFields
