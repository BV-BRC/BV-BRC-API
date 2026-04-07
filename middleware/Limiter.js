const MAX_LIMIT = 50000
const DEFAULT_LIMIT = 25
const DOWNLOAD_LIMIT = 2500000
const ID_COUNT_BUFFER = 10

/**
 * Detect queries with fixed ID lists and return the count of IDs.
 * Matches patterns like: field:(id1 OR id2 OR id3...)
 * This helps optimize queries where we know the maximum possible results.
 *
 * @param {string} query - The Solr query string
 * @returns {number|null} - The count of IDs if detected, null otherwise
 */
function detectFixedIdCount (query) {
  if (!query) return null

  // Match patterns like: field:(val1 OR val2 OR val3) or field:(val1+OR+val2+OR+val3)
  // Common fields: md5, genome_id, feature_id, patric_id, id, subsystem_id
  const orPattern = /\b(md5|genome_id|feature_id|patric_id|id|subsystem_id):\(([^)]+)\)/gi

  let maxIdCount = 0

  let match
  while ((match = orPattern.exec(query)) !== null) {
    const idsClause = match[2]
    // Count OR separators (handles both " OR " and "+OR+")
    const orCount = (idsClause.match(/(\+OR\+|\sOR\s)/gi) || []).length
    // Number of IDs = OR count + 1
    const idCount = orCount + 1
    if (idCount > maxIdCount) {
      maxIdCount = idCount
    }
  }

  return maxIdCount > 1 ? maxIdCount : null
}

module.exports = function (req, res, next) {
  if (req.call_method !== 'query') { return next() }

  // Use request ID set by app.js middleware
  const requestId = req.requestId || 'unknown'

  let limit = MAX_LIMIT
  const q = req.call_params[0]
  const rowsRegPattern = /(&rows=)(\d*)/
  const groupRegPattern = /&group=true/
  const groupRegMatches = q.match(groupRegPattern)
  const rowsRegMatches = q.match(rowsRegPattern)
  let queryOffset

  // Log incoming query for debugging large row requests
  const incomingRows = rowsRegMatches ? rowsRegMatches[2] : 'not specified'
  if (incomingRows > 100000) {
    console.log(`[Limiter] ${requestId} Incoming query with rows=${incomingRows}, collection=${req.call_collection}, queryType=${req.queryType}`)
  }

  if (groupRegMatches) {
    limit = 99999999
  } else {
    if (!rowsRegMatches) {
      limit = DEFAULT_LIMIT
    } else if (rowsRegMatches && typeof rowsRegMatches[2] !== 'undefined' && (rowsRegMatches[2] > DOWNLOAD_LIMIT) && req.isDownload) {
      limit = DOWNLOAD_LIMIT
    } else if (rowsRegMatches && typeof rowsRegMatches[2] !== 'undefined' && (rowsRegMatches[2] > MAX_LIMIT) && (!req.isDownload)) {
      limit = MAX_LIMIT
    } else {
      limit = rowsRegMatches[2]
    }
  }
  if (req.headers.range) {
    const rangeMatches = req.headers.range.match(/^items=(\d+)-(\d+)?$/)

    if (rangeMatches) {
      const start = rangeMatches[1] || 0
      const end = rangeMatches[2] || MAX_LIMIT
      const l = end - start
      if (l > MAX_LIMIT) {
        limit = MAX_LIMIT
      } else {
        limit = l
      }

      queryOffset = start
    }
  }

  if (rowsRegMatches) {
    req.call_params[0] = q.replace(rowsRegMatches[0], '&rows=' + limit)
  } else {
    req.call_params[0] = req.call_params[0] + '&rows=' + limit
  }

  // Check for fixed ID list queries and cap limit if appropriate
  const idCount = detectFixedIdCount(req.call_params[0])
  if (idCount) {
    const idBasedLimit = idCount + ID_COUNT_BUFFER
    if (idBasedLimit < limit) {
      console.log(`[Limiter] ${requestId} Fixed ID query detected: ${idCount} IDs, capping limit from ${limit} to ${idBasedLimit}`)
      req.call_params[0] = req.call_params[0].replace(/&rows=\d+/, '&rows=' + idBasedLimit)
      limit = idBasedLimit
    }
  }

  // Add request ID to query for Solr log correlation
  req.call_params[0] = req.call_params[0] + '&p3api_rid=' + requestId

  // Log summary for feature_sequence queries (debugging OOM issue)
  if (req.call_collection === 'feature_sequence') {
    console.log(`[Limiter] ${requestId} feature_sequence query: rows=${limit} idCount=${idCount || 'N/A'}`)
  }

  if (queryOffset) {
    const offsetMatches = q.match(/(&start=)(\d+)/)
    if (!offsetMatches) {
      req.call_params[0] = req.call_params[0] + '&start=' + queryOffset
    }
  }

  next()
}
