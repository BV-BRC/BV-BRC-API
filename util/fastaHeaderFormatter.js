/**
 * FASTA Header Formatter
 *
 * Generates FASTA headers from configurable field lists.
 * Supports user-specified fields via HTTP request parameters.
 *
 * Default format:
 *   >ID_FIELD1|ID_FIELD2|... DESCRIPTION_FIELD1 [CONTEXT_FIELD1 | CONTEXT_FIELD2]
 *
 * Configuration via request params:
 *   - http_fasta_id_fields: comma-separated list of fields for ID portion
 *   - http_fasta_id_delimiter: delimiter between ID fields (default: '|')
 *   - http_fasta_description_fields: comma-separated list of fields for description
 *   - http_fasta_context_fields: comma-separated list of fields for [context]
 */

const debug = require('debug')('p3api-server:util:fasta-header')
const url = require('url')

/**
 * Default FASTA header configuration by collection and annotation type
 */
const DEFAULT_CONFIG = {
  // genome_feature collection
  genome_feature: {
    PATRIC: {
      idFields: ['patric_id', 'refseq_locus_tag', 'alt_locus_tag'],
      descriptionFields: ['product'],
      contextFields: ['genome_name', 'genome_id']
    },
    RefSeq: {
      idFields: ['gi', 'refseq_locus_tag', 'alt_locus_tag'],
      idPrefix: 'gi|',
      descriptionFields: ['product'],
      contextFields: ['genome_name', 'genome_id']
    },
    default: {
      idFields: ['patric_id', 'refseq_locus_tag', 'alt_locus_tag'],
      descriptionFields: ['product'],
      contextFields: ['genome_name', 'genome_id']
    }
  },
  // genome_sequence collection
  genome_sequence: {
    default: {
      idFields: ['accession'],
      idPrefix: 'accn|',
      descriptionFields: ['description'],
      contextFields: ['genome_name', 'genome_id']
    }
  }
}

/**
 * Get query parameters from request.
 * Handles both Express req.query and custom http-params middleware.
 * Also checks req.fastaParams for FASTA-specific parameters extracted by http-params.
 *
 * @param {Object} req - Express request object
 * @returns {Object} Query parameters object
 */
function getQueryParams (req) {
  let params = {}

  // If Express has parsed query params, use them
  if (req.query && Object.keys(req.query).length > 0) {
    params = { ...req.query }
  } else {
    // Otherwise parse from _parsedUrl.query (set by http-params middleware)
    // or from call_params[0]
    let queryString = ''
    if (req._parsedUrl && req._parsedUrl.query) {
      queryString = req._parsedUrl.query
    } else if (req.call_params && req.call_params[0]) {
      queryString = req.call_params[0]
    }

    if (queryString) {
      // Parse the query string
      const parsed = url.parse('?' + queryString, true)
      params = parsed.query || {}
    }
  }

  // Merge in FASTA params from http-params middleware
  // These are stored separately to avoid being sent to Solr
  if (req.fastaParams && Object.keys(req.fastaParams).length > 0) {
    params = { ...params, ...req.fastaParams }
  }

  return params
}

/**
 * Parse FASTA header configuration from request.
 *
 * @param {Object} req - Express request object
 * @returns {Object} Parsed configuration
 */
function parseConfigFromRequest (req) {
  const config = {}
  const query = getQueryParams(req)

  // ID fields configuration
  // Use !== undefined to allow empty string to mean "no ID fields"
  if (query.http_fasta_id_fields !== undefined) {
    config.idFields = query.http_fasta_id_fields
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0)
  }

  // ID delimiter
  if (query.http_fasta_id_delimiter !== undefined) {
    config.idDelimiter = query.http_fasta_id_delimiter
  }

  // ID prefix (e.g., 'gi|' or 'accn|')
  if (query.http_fasta_id_prefix !== undefined) {
    config.idPrefix = query.http_fasta_id_prefix
  }

  // Description fields
  // Use !== undefined to allow empty string to mean "no description fields"
  if (query.http_fasta_description_fields !== undefined) {
    config.descriptionFields = query.http_fasta_description_fields
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0)
  }

  // Context fields (shown in brackets)
  // Use !== undefined to allow empty string to mean "no context fields"
  if (query.http_fasta_context_fields !== undefined) {
    config.contextFields = query.http_fasta_context_fields
      .split(',')
      .map(f => f.trim())
      .filter(f => f.length > 0)
  }

  // Context delimiter (between fields in brackets)
  if (query.http_fasta_context_delimiter !== undefined) {
    config.contextDelimiter = query.http_fasta_context_delimiter
  }

  return config
}

/**
 * Get field value from document, supporting nested paths.
 *
 * @param {Object} doc - Document
 * @param {string} field - Field name (supports dot notation for nested)
 * @returns {string|undefined} Field value
 */
function getFieldValue (doc, field) {
  if (!doc || !field) {
    return undefined
  }

  // Support nested fields like 'genome_metadata.genome_name'
  const parts = field.split('.')
  let value = doc

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part]
    } else {
      return undefined
    }
  }

  // Handle arrays (join with comma)
  if (Array.isArray(value)) {
    return value.join(',')
  }

  return value !== undefined && value !== null ? String(value) : undefined
}

/**
 * Format an array of field values with a delimiter.
 * Skips undefined/null/empty values.
 *
 * @param {Object} doc - Document
 * @param {Array<string>} fields - Field names
 * @param {string} delimiter - Delimiter between values
 * @param {boolean} [includeEmpty=false] - Include empty placeholders
 * @returns {string} Formatted string
 */
function formatFields (doc, fields, delimiter, includeEmpty = false) {
  const values = []

  for (const field of fields) {
    const value = getFieldValue(doc, field)
    if (value !== undefined && value !== '') {
      values.push(value)
    } else if (includeEmpty) {
      values.push('')
    }
  }

  return values.join(delimiter)
}

/**
 * Create a FASTA header formatter function.
 *
 * @param {Object} [options] - Configuration options
 * @param {Array<string>} [options.idFields] - Fields for ID portion
 * @param {string} [options.idDelimiter='|'] - Delimiter between ID fields
 * @param {string} [options.idPrefix=''] - Prefix for ID (e.g., 'gi|')
 * @param {Array<string>} [options.descriptionFields] - Fields for description
 * @param {Array<string>} [options.contextFields] - Fields for [context] portion
 * @param {string} [options.contextDelimiter=' | '] - Delimiter in context
 * @param {string} [options.collection] - Collection name (for defaults)
 * @returns {Function} Formatter function (doc) => header string
 */
function createFastaHeaderFormatter (options = {}) {
  const config = {
    idFields: options.idFields || ['id'],
    idDelimiter: options.idDelimiter !== undefined ? options.idDelimiter : '|',
    idPrefix: options.idPrefix || '',
    descriptionFields: options.descriptionFields || [],
    contextFields: options.contextFields || [],
    contextDelimiter: options.contextDelimiter !== undefined ? options.contextDelimiter : ' | '
  }

  debug(`Created FASTA header formatter: id=[${config.idFields.join(',')}] ` +
        `desc=[${config.descriptionFields.join(',')}] ` +
        `ctx=[${config.contextFields.join(',')}]`)

  return function formatHeader (doc) {
    const parts = []

    // ID portion
    let id = formatFields(doc, config.idFields, config.idDelimiter)
    if (config.idPrefix && id) {
      id = config.idPrefix + id
    }
    // Add trailing delimiter to ID section (matches legacy format)
    if (id && config.idDelimiter) {
      id = id + config.idDelimiter
    }
    parts.push('>' + (id || 'unknown'))

    // Description portion
    if (config.descriptionFields.length > 0) {
      const description = formatFields(doc, config.descriptionFields, ' ')
      if (description) {
        parts.push(description)
      }
    }

    // Context portion (in brackets)
    if (config.contextFields.length > 0) {
      const context = formatFields(doc, config.contextFields, config.contextDelimiter)
      if (context) {
        parts.push(`[${context}]`)
      }
    }

    return parts.join(' ') + '\n'
  }
}

/**
 * Create a FASTA header formatter from an Express request.
 * Merges request parameters with defaults for the collection.
 *
 * @param {Object} req - Express request object
 * @param {Object} [options] - Additional options
 * @param {string} [options.sequenceType='dna'] - 'dna' or 'protein'
 * @returns {Function} Formatter function
 */
function createFastaHeaderFormatterFromRequest (req, options = {}) {
  const collection = req.call_collection || 'genome_feature'
  const query = getQueryParams(req)
  const annotation = query.annotation || null

  // Get defaults for this collection/annotation
  const collectionDefaults = DEFAULT_CONFIG[collection] || DEFAULT_CONFIG.genome_feature
  let defaults

  if (annotation && collectionDefaults[annotation]) {
    defaults = collectionDefaults[annotation]
  } else {
    defaults = collectionDefaults.default || collectionDefaults.PATRIC || {}
  }

  // Parse user configuration from request
  const userConfig = parseConfigFromRequest(req)

  // Merge: user config overrides defaults
  const mergedConfig = {
    idFields: userConfig.idFields || defaults.idFields || ['id'],
    idDelimiter: userConfig.idDelimiter !== undefined ? userConfig.idDelimiter : (defaults.idDelimiter || '|'),
    idPrefix: userConfig.idPrefix !== undefined ? userConfig.idPrefix : (defaults.idPrefix || ''),
    descriptionFields: userConfig.descriptionFields || defaults.descriptionFields || [],
    contextFields: userConfig.contextFields || defaults.contextFields || [],
    contextDelimiter: userConfig.contextDelimiter !== undefined ? userConfig.contextDelimiter : (defaults.contextDelimiter || ' | '),
    collection
  }

  debug(`FASTA header config for ${collection}/${annotation || 'default'}: ` +
        `id=[${mergedConfig.idFields.join(',')}]`)

  return createFastaHeaderFormatter(mergedConfig)
}

/**
 * Legacy FASTA header formatter for backward compatibility.
 * Matches the original format from dna+fasta.js and protein+fasta.js.
 *
 * @param {Object} doc - Feature document
 * @param {string} [sequenceType='dna'] - 'dna' or 'protein'
 * @returns {string} FASTA header line
 */
function formatLegacyHeader (doc, sequenceType = 'dna') {
  let fastaId

  if (doc.annotation === 'PATRIC') {
    fastaId = doc.patric_id || ''
    if (doc.refseq_locus_tag) fastaId += '|' + doc.refseq_locus_tag
    if (doc.alt_locus_tag) fastaId += '|' + doc.alt_locus_tag
  } else if (doc.annotation === 'RefSeq') {
    fastaId = 'gi|' + (doc.gi || '')
    if (doc.refseq_locus_tag) fastaId += '|' + doc.refseq_locus_tag
    if (doc.alt_locus_tag) fastaId += '|' + doc.alt_locus_tag
  } else {
    // Fallback
    fastaId = doc.patric_id || doc.feature_id || doc.id || 'unknown'
  }

  const product = doc.product || ''
  const genomeName = doc.genome_name || ''
  const genomeId = doc.genome_id || ''

  return `>${fastaId} ${product} [${genomeName} | ${genomeId}]\n`
}

/**
 * Legacy genome sequence header formatter.
 *
 * @param {Object} doc - Genome sequence document
 * @returns {string} FASTA header line
 */
function formatLegacyGenomeSequenceHeader (doc) {
  const accession = doc.accession || 'unknown'
  const description = doc.description || ''
  const genomeName = doc.genome_name || ''
  const genomeId = doc.genome_id || ''

  return `>accn|${accession}   ${description}   [${genomeName} | ${genomeId}]\n`
}

module.exports = {
  createFastaHeaderFormatter,
  createFastaHeaderFormatterFromRequest,
  parseConfigFromRequest,
  formatLegacyHeader,
  formatLegacyGenomeSequenceHeader,
  getFieldValue,
  formatFields,
  getQueryParams,
  DEFAULT_CONFIG
}
