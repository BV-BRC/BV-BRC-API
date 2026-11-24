const MAX_LIMIT = 50000
const DEFAULT_LIMIT = 25
const DOWNLOAD_LIMIT = 2500000
const ID_COUNT_BUFFER = 10

/**
 * Detect queries with fixed ID lists and return the count of IDs.
 * Only applies when querying by the PRIMARY KEY of a collection,
 * where we know the max results equals the number of IDs.
 *
 * Two forms are recognized, because RQL has two operators that produce one:
 *
 *   in(pk,(a,b,c))     -> q= ... (pk:(a OR b OR c))
 *   terms(pk,(a,b,c))  -> &fq={!terms f=pk cache=false}a,b,c
 *
 * Both must be seen or the two operators get different `rows` for the same id
 * list, and that is not a wash. `rows` is what DistributedQuery tests against
 * `minLimitThreshold`, so with only in() detected a client sending the usual
 * limit(25000) has its in() query capped onto the standard path while the
 * equivalent terms() query keeps rows=25000 and engages the distributed one.
 * The two then run on entirely different transports, which is how an external
 * benchmark came to measure terms() as several times slower on small lists.
 *
 * @param {string} query - The Solr query string
 * @param {string} collection - The collection being queried
 * @returns {number|null} - The count of IDs if detected, null otherwise
 */
function detectFixedIdCount (query, collection) {
  if (!query || !collection) return null

  // Map of collection -> primary key field(s)
  // Only these combinations should trigger ID-based limiting
  const primaryKeyMap = {
    'feature_sequence': ['md5'],
    'genome': ['genome_id'],
    'genome_feature': ['feature_id', 'patric_id'],
    'genome_sequence': ['sequence_id'],
    'pathway': ['pathway_id'],
    'subsystem': ['subsystem_id'],
    'taxonomy': ['taxon_id'],
    'sp_gene': ['id'],
    'protein_family_ref': ['family_id']
  }

  const primaryKeys = primaryKeyMap[collection]
  if (!primaryKeys) return null

  // Build regex pattern for this collection's primary keys only
  const keysPattern = primaryKeys.join('|')
  const orPattern = new RegExp(`\\b(${keysPattern}):\\(([^)]+)\\)`, 'gi')

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

  // terms(): a {!terms} filter in its own &fq=. Anchored to fq because an fq is
  // ANDed, which makes the value count a hard upper bound on the result set —
  // a stronger guarantee than the pattern above, which also matches inside an
  // or() where the count bounds nothing.
  const termsPattern = /(?:^|&)fq=\{!terms\b([^}]*)\}([^&]*)/gi
  const termsKeyPattern = new RegExp(`\\bf=(?:${keysPattern})(?=\\s|$)`, 'i')

  while ((match = termsPattern.exec(query)) !== null) {
    const localParams = match[1]
    if (!termsKeyPattern.test(localParams)) continue

    // Values are comma-joined. A `separator` local param would change that;
    // nothing we emit sets one, so skip rather than miscount.
    if (/\bseparator\s*=/i.test(localParams)) continue

    const values = match[2]
    if (!values) continue

    const idCount = (values.match(/,/g) || []).length + 1
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

  // Skip Range header / start injection when cursor pagination is active
  // Cursors and offsets are mutually exclusive in Solr
  if (!req.cursorMark && req.headers.range) {
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
  // Only applies when querying by primary key of the collection
  const idCount = detectFixedIdCount(req.call_params[0], req.call_collection)
  if (idCount) {
    const idBasedLimit = idCount + ID_COUNT_BUFFER
    if (idBasedLimit < limit) {
      console.log(`[Limiter] ${requestId} Fixed ID query detected: ${idCount} IDs, capping limit from ${limit} to ${idBasedLimit}`)
      req.call_params[0] = req.call_params[0].replace(/&rows=\d+/, '&rows=' + idBasedLimit)
      limit = idBasedLimit
    }
  }

  // Add request ID to query for Solr log correlation
  // Using 'appRid' to avoid conflict with Solr's internal 'rid' parameter
  req.call_params[0] = req.call_params[0] + '&appRid=' + requestId

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
