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
 *   - http_fasta_description_delimiter: delimiter between description fields
 *       (default: ' ' -- a single space, which is the historical format)
 *   - http_fasta_context_fields: comma-separated list of fields for [context]
 *   - http_fasta_header: a FORMAT STRING, which overrides all of the above. See
 *       formatTemplate() below for the grammar.
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

  // Description delimiter. Mirrors the id/context delimiters: `!== undefined` so an
  // explicitly empty value is honoured (fields run together) rather than falling back
  // to the default.
  if (query.http_fasta_description_delimiter !== undefined) {
    config.descriptionDelimiter = query.http_fasta_description_delimiter
  }

  // Format string. Overrides every zone parameter; see decision 2.
  if (query.http_fasta_header !== undefined && String(query.http_fasta_header).trim() !== '') {
    config.template = String(query.http_fasta_header)
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
      value = undefined
      break
    }
  }

  // BARE NAMES fall back to the joined genome metadata.
  //
  // `/fields` reports `host_name`, not `genome_metadata.host_name`, and select() has
  // always taken bare names -- so a client consuming the field registry passes bare
  // names here. Without this fallback they resolve to undefined and are SILENTLY
  // dropped from the header, which is exactly what a GUI session hit on 2026-10-30.
  //
  // Checked only after a direct lookup fails, so a field that genuinely exists on the
  // document always wins; this can only add a value where there would have been none.
  if (value === undefined && parts.length === 1 &&
      doc.genome_metadata && typeof doc.genome_metadata === 'object' &&
      field in doc.genome_metadata) {
    value = doc.genome_metadata[field]
  }

  if (value === undefined) {
    return undefined
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

// ---------------------------------------------------------------------------
// Format strings (http_fasta_header)
//
// The three-zone scheme (id / description / context) cannot express a header whose
// literal text does not match `>ID DESC [CTX]`, and the community parses these headers
// with their own tooling, so the shape matters to them. A format string lets a caller
// state the layout outright:
//
//   http_fasta_header={patric_id}|{genome_id} {product} [{genome_name}]
//     -> >fig|1.1.peg.1|1.1 ABC transporter [E. coli K-12]
//
// FOUR DECISIONS, settled deliberately rather than discovered during implementation:
//
// 1. MISSING VALUES render as empty, and the template is NOT rewritten around them.
//    The zone scheme skips an absent field and collapses the delimiter with it; a
//    template cannot do that without inventing conditional syntax, and guessing which
//    adjacent literals to drop would be worse than a visible gap. Callers who need
//    "omit when absent" should keep using the zone parameters, which still work.
//
// 2. EXCLUSIVE. When http_fasta_header is present the zone parameters are ignored
//    entirely, rather than merged. Merging two layout models produces headers nobody
//    predicted, and the failure would be silent.
//
// 3. `{{` and `}}` are literal braces, the usual convention.
//
// 4. SYNTAX errors are a 400; an UNKNOWN FIELD NAME renders empty and returns 200.
//
//    An earlier draft of this comment claimed unknown names were rejected too. They
//    are not, and saying so was worse than the gap itself -- a GUI client read the
//    contract, relied on it, and found `{hostname}` (a typo of host_name) producing a
//    silently truncated header with HTTP 200.
//
//    The reason is cost: deciding whether a bare name is valid needs the collection's
//    Solr schema, and fetching it would add a round trip to EVERY templated download,
//    on the request path, for a check a client can make once against
//    /:collection/fields. Syntax is checked because it needs nothing but the string.
//
//    CONSEQUENCE FOR CLIENTS: validating template field names against
//    /:collection/fields is load-bearing, not a nicety. Nothing server-side will catch
//    a typo.
//
// Note this makes STRUCTURE explicit but does not add escaping: values are still
// interpolated verbatim, so a value containing the caller's own separator remains
// ambiguous. That is a known and deliberate gap.

/**
 * Field names referenced by a template, in order of first appearance.
 *
 * @param {string} template
 * @returns {Array<string>}
 */
function templateFields (template) {
  return scanTemplate(template, () => '').fields
}

/**
 * Single-pass template scanner. THE ONE PLACE template syntax is interpreted.
 *
 * templateFields() and formatTemplate() both go through this, because when they parsed
 * separately they disagreed: discovery blanked escaped braces with a sentinel and
 * returned a corrupted name for `{{{field}}}`, while the renderer substituted the real
 * field. A field the join never fetched then rendered empty -- the silent-drop failure
 * this whole module exists to avoid.
 *
 * @param {string} template
 * @param {Function} resolve - (name) => string, the value to emit for a reference
 * @returns {{ text: string, fields: Array<string> }}
 */
function scanTemplate (template, resolve) {
  if (!template || typeof template !== 'string') return { text: '', fields: [] }

  const fields = []
  let out = ''
  let i = 0

  while (i < template.length) {
    const two = template.slice(i, i + 2)
    // Escaped braces are literal, and are consumed before any reference is considered.
    if (two === '{{') { out += '{'; i += 2; continue }
    if (two === '}}') { out += '}'; i += 2; continue }

    if (template[i] === '{') {
      const close = template.indexOf('}', i + 1)
      if (close !== -1) {
        const name = template.slice(i + 1, close).trim()
        if (name) {
          if (!fields.includes(name)) fields.push(name)
          out += resolve(name)
          i = close + 1
          continue
        }
      }
    }
    out += template[i]
    i += 1
  }

  return { text: out, fields }
}

/**
 * Validate a template's syntax.
 *
 * Checks only what is knowable without a document: brace balance and non-empty field
 * names. Whether a NAME is valid for the collection is checked by the caller, which
 * has the field registry.
 *
 * @param {string} template
 * @returns {string|null} an error message, or null when the template is well-formed
 */
function validateTemplate (template) {
  if (typeof template !== 'string') return 'http_fasta_header must be a string'
  if (template.trim() === '') return 'http_fasta_header must not be empty'

  const scannable = template.replace(/\{\{/g, '\0').replace(/\}\}/g, '\0')
  // An unmatched brace means the caller mistyped; rendering it literally would produce
  // a header that silently differs from what they wrote.
  const opens = (scannable.match(/\{/g) || []).length
  const closes = (scannable.match(/\}/g) || []).length
  if (opens !== closes) {
    return 'http_fasta_header has unbalanced braces (use {{ and }} for literal braces)'
  }
  if (/\{\s*\}/.test(scannable)) {
    return 'http_fasta_header contains an empty field reference {}'
  }
  return null
}

/**
 * Render a template against a document.
 *
 * @param {Object} doc
 * @param {string} template
 * @returns {string} the header line, WITHOUT the leading '>' or trailing newline
 */
function formatTemplate (doc, template) {
  return scanTemplate(template, (name) => {
    const value = getFieldValue(doc, name)
    return value === undefined ? '' : value
  }).text
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
    // Defaults to a single space: the historical format, which the community already
    // parses with their own tooling. Every existing header stays byte-identical unless
    // a caller explicitly asks for something else.
    descriptionDelimiter: options.descriptionDelimiter !== undefined
      ? options.descriptionDelimiter
      : ' ',
    contextFields: options.contextFields || [],
    contextDelimiter: options.contextDelimiter !== undefined ? options.contextDelimiter : ' | ',
    template: options.template || null
  }

  debug(`Created FASTA header formatter: id=[${config.idFields.join(',')}] ` +
        `desc=[${config.descriptionFields.join(',')}] ` +
        `ctx=[${config.contextFields.join(',')}]`)

  return function formatHeader (doc) {
    // A format string replaces the zone layout entirely -- see decision 2 above.
    if (config.template) {
      return '>' + formatTemplate(doc, config.template) + '\n'
    }

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
      const description = formatFields(doc, config.descriptionFields, config.descriptionDelimiter)
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
    descriptionDelimiter: userConfig.descriptionDelimiter !== undefined
      ? userConfig.descriptionDelimiter
      : (defaults.descriptionDelimiter !== undefined ? defaults.descriptionDelimiter : ' '),
    contextFields: userConfig.contextFields || defaults.contextFields || [],
    contextDelimiter: userConfig.contextDelimiter !== undefined ? userConfig.contextDelimiter : (defaults.contextDelimiter || ' | '),
    template: userConfig.template || null,
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
  templateFields,
  scanTemplate,
  validateTemplate,
  formatTemplate,
  parseConfigFromRequest,
  formatLegacyHeader,
  formatLegacyGenomeSequenceHeader,
  getFieldValue,
  formatFields,
  getQueryParams,
  DEFAULT_CONFIG
}
