/**
 * Distributed Query Middleware
 *
 * Routes qualifying queries through the distributed query system for improved
 * performance on large result sets. Integrates with the existing middleware chain
 * after DecorateQuery (permission filters applied) and Limiter (limits enforced).
 *
 * Decision criteria for using distributed query:
 * 1. Collection must be in enabledCollections (or not in disabledCollections)
 * 2. Request limit must exceed minLimitThreshold
 * 3. Call method must be 'query' or 'stream' (not 'get')
 * 4. Can be overridden via X-Distributed-Query header or ?distributed= query param
 *
 * Security: Permission filters are already applied by DecorateQuery middleware
 * before this middleware runs, so all security controls are preserved.
 */

const debug = require('debug')('p3api-server:middleware/DistributedQuery')
const Config = require('../config')
const { getConfig } = require('../lib/distributed/DistributedQueryConfig')

// Singleton manager instance (lazy initialized)
let distributedQueryManager = null
let managerInitPromise = null

/**
 * Get or create the DistributedQueryManager singleton.
 * @returns {Promise<DistributedQueryManager>}
 */
async function getManager () {
  if (distributedQueryManager) {
    return distributedQueryManager
  }

  if (managerInitPromise) {
    return managerInitPromise
  }

  managerInitPromise = (async () => {
    const DistributedQueryManager = require('../lib/distributed/DistributedQueryManager')
    const solrUrl = Config.get('solr').url
    const config = getConfig()

    distributedQueryManager = new DistributedQueryManager(solrUrl, {
      rejectUnauthorized: config.rejectUnauthorized,
      ca: config.ca
    })

    debug('DistributedQueryManager initialized')
    return distributedQueryManager
  })()

  return managerInitPromise
}

/**
 * Parse the limit from a Solr query string.
 * @param {string} query - Solr query string
 * @returns {number} The limit (rows) value, or 0 if not found
 */
function parseLimit (query) {
  const match = query.match(/[&?]rows=(\d+)/)
  if (match) {
    return parseInt(match[1], 10)
  }
  return 0
}

/**
 * Parse the sort from a Solr query string.
 * @param {string} query - Solr query string
 * @returns {string|null} The sort value, or null if not found
 */
function parseSort (query) {
  const match = query.match(/[&?]sort=([^&]+)/)
  if (match) {
    // Replace + with space before decoding (+ is space in URL query strings)
    return decodeURIComponent(match[1].replace(/\+/g, ' '))
  }
  return null
}

/**
 * Parse the field list from a Solr query string.
 * @param {string} query - Solr query string
 * @returns {string|null} The fl value, or null if not found
 */
function parseFields (query) {
  const match = query.match(/[&?]fl=([^&]+)/)
  if (match) {
    // Replace + with space before decoding (+ is space in URL query strings)
    return decodeURIComponent(match[1].replace(/\+/g, ' '))
  }
  return null
}

/**
 * Strip parameters from a query string that will be added by ShardCursorStream.
 * These include: q, rows, sort, fl, cursorMark, wt, shards, preferLocalShards
 *
 * The distributed query system adds its own versions of these parameters,
 * so we need to remove them from the original query to avoid duplication.
 *
 * @param {string} query - Solr query string
 * @returns {string} Query string with only fq and other non-conflicting parameters
 */
function stripManagedParams (query) {
  // Parameters that ShardCursorStream will add/manage
  const managedParams = ['q', 'rows', 'sort', 'fl', 'cursorMark', 'wt', 'shards', 'preferLocalShards', 'start', 'distributed']

  // Handle query strings that may or may not start with ? or &
  let queryStr = query
  if (queryStr.startsWith('?') || queryStr.startsWith('&')) {
    queryStr = queryStr.substring(1)
  }

  // Split by & and filter out managed params
  const params = []
  const parts = queryStr.split('&')
  for (const part of parts) {
    if (!part) continue

    const eqIndex = part.indexOf('=')
    const paramName = eqIndex > 0 ? part.substring(0, eqIndex) : part

    // Keep this param if it's not in the managed list
    if (!managedParams.includes(paramName)) {
      params.push(part)
    }
  }

  // Return the filtered query string (with leading & for appending)
  if (params.length === 0) {
    return ''
  }
  return '&' + params.join('&')
}

/**
 * Check if distributed query should be used for this request.
 *
 * @param {Object} req - Express request object
 * @param {Object} config - Distributed query config
 * @returns {Object} Decision object with { useDistributed, reason }
 */
function shouldUseDistributedQuery (req, config) {
  // Check if distributed query is globally enabled
  if (!config.enabled) {
    return { useDistributed: false, reason: 'disabled globally' }
  }

  // Check for explicit header override
  const headerOverride = req.headers['x-distributed-query']
  if (headerOverride !== undefined) {
    const useIt = headerOverride === 'true' || headerOverride === '1'
    return {
      useDistributed: useIt,
      reason: useIt ? 'header override (enabled)' : 'header override (disabled)'
    }
  }

  // Check for query param override
  const query = req.call_params[0] || ''
  const distributedParam = query.match(/[&?]distributed=(true|false|1|0)/)
  if (distributedParam) {
    const useIt = distributedParam[1] === 'true' || distributedParam[1] === '1'
    return {
      useDistributed: useIt,
      reason: useIt ? 'query param override (enabled)' : 'query param override (disabled)'
    }
  }

  // Only applies to query and stream methods
  if (req.call_method !== 'query' && req.call_method !== 'stream') {
    return { useDistributed: false, reason: `method ${req.call_method} not supported` }
  }

  const collection = req.call_collection

  // Check collection whitelist/blacklist
  if (config.enabledCollections && config.enabledCollections.length > 0) {
    if (!config.enabledCollections.includes(collection)) {
      return { useDistributed: false, reason: `collection ${collection} not in enabledCollections` }
    }
  }

  if (config.disabledCollections && config.disabledCollections.length > 0) {
    if (config.disabledCollections.includes(collection)) {
      return { useDistributed: false, reason: `collection ${collection} in disabledCollections` }
    }
  }

  // Check limit threshold
  const limit = parseLimit(query)
  const threshold = config.minLimitThreshold || 10000

  if (limit < threshold) {
    return { useDistributed: false, reason: `limit ${limit} below threshold ${threshold}` }
  }

  return { useDistributed: true, reason: `limit ${limit} >= threshold ${threshold}` }
}

/**
 * Create a stream wrapper that makes the distributed query stream compatible
 * with the existing media handlers.
 *
 * The existing media handlers expect res.results to have a specific format:
 * - For 'stream' method: { stream: ReadableStream }
 * - For 'query' method: { response: { docs: [...], numFound: N } }
 *
 * @param {Object} queryResult - Result from DistributedQueryManager.executeQuery()
 * @param {string} callMethod - The request call method ('query' or 'stream')
 * @returns {Object} Result object compatible with media handlers
 */
function wrapForMediaHandler (queryResult, callMethod) {
  if (callMethod === 'stream') {
    // For streaming, media handlers expect { stream: ReadableStream }
    // The stream should emit objects (documents) in object mode
    // Add a fake 'head' object first as expected by json.js media handler
    const { Transform } = require('stream')
    let sentHead = false

    const wrappedStream = new Transform({
      objectMode: true,
      transform (doc, encoding, callback) {
        if (!sentHead) {
          // Send an empty head object first (matches solrjs stream behavior)
          this.push({})
          sentHead = true
        }
        callback(null, doc)
      }
    })

    queryResult.stream.pipe(wrappedStream)

    return {
      stream: wrappedStream
    }
  } else {
    // For query method, we need to collect all docs into an array
    // But since we're dealing with large result sets, we should switch to stream mode
    // and let the media handler stream the results

    // Actually, for query method with large results, we'll change the call_method to 'stream'
    // This is handled in the middleware below
    return {
      stream: queryResult.stream
    }
  }
}

/**
 * Distributed Query Middleware
 *
 * Checks if the request qualifies for distributed query execution and
 * routes qualifying queries through the distributed query system.
 */
module.exports = async function distributedQueryMiddleware (req, res, next) {
  // Only process if we have a call method and collection
  if (!req.call_method || !req.call_collection) {
    return next()
  }

  const config = getConfig()
  const decision = shouldUseDistributedQuery(req, config)

  debug(`Collection: ${req.call_collection}, Method: ${req.call_method}, Decision: ${decision.useDistributed} (${decision.reason})`)

  if (!decision.useDistributed) {
    return next()
  }

  // Use distributed query
  try {
    const manager = await getManager()
    const query = req.call_params[0] || ''

    // Parse query parameters before stripping
    const limit = parseLimit(query)
    const sort = parseSort(query)
    const fields = parseFields(query)

    // Strip parameters that ShardCursorStream will add to avoid duplication
    // Keep only fq (filter queries) and other non-conflicting parameters
    const strippedQuery = stripManagedParams(query)

    debug(`Executing distributed query: collection=${req.call_collection}, limit=${limit}, sort=${sort}`)
    debug(`Stripped query for shards: ${strippedQuery}`)

    const startTime = Date.now()

    // Execute the distributed query
    const queryResult = await manager.executeQuery({
      collection: req.call_collection,
      query: strippedQuery,
      queryType: 'solr', // Query is already in Solr format after RQLQueryParser
      sort: sort,
      fields: fields,
      limit: limit,
      requireSorted: !!sort
    })

    const setupTime = Date.now() - startTime
    debug(`Distributed query setup completed in ${setupTime}ms, streamType=${queryResult.metadata.streamType}`)

    // Set response headers if configured
    if (config.exposeMetadataHeaders) {
      res.set('X-Distributed-Query', 'true')
      res.set('X-Stream-Type', queryResult.metadata.streamType)
      res.set('X-Parallelism', String(queryResult.metadata.parallelism))
      res.set('X-Shard-Count', String(queryResult.metadata.shardCount))

      if (queryResult.metadata.totalFound !== null) {
        res.set('X-Total-Found', String(queryResult.metadata.totalFound))
      }
      if (queryResult.metadata.prewarmElapsedMs !== null) {
        res.set('X-Prewarm-Time-Ms', String(queryResult.metadata.prewarmElapsedMs))
      }
    }

    // For large result sets, always use streaming mode
    // This ensures efficient memory usage regardless of original call method
    const originalCallMethod = req.call_method
    if (originalCallMethod === 'query') {
      req.call_method = 'stream'
      debug('Switched call_method from query to stream for distributed query')
    }

    // Wrap the result for media handler compatibility
    res.results = wrapForMediaHandler(queryResult, 'stream')

    // Set flag to skip APIMethodHandler
    req.skipAPIMethodHandler = true

    // Track query for cleanup on response finish
    res.on('finish', () => {
      debug(`Distributed query completed, total time: ${Date.now() - startTime}ms`)
    })

    res.on('close', () => {
      // Cancel query if client disconnects
      if (queryResult.cancel) {
        debug('Client disconnected, cancelling distributed query')
        queryResult.cancel()
      }
    })

    next()
  } catch (err) {
    // Log the error and fall back to standard query
    console.error(`Distributed query failed, falling back to standard query: ${err.message}`)
    debug(`Distributed query error: ${err.stack}`)

    // Increment circuit breaker counter here if implemented
    // For now, just fall back to standard query
    next()
  }
}

// Export for testing
module.exports.shouldUseDistributedQuery = shouldUseDistributedQuery
module.exports.parseLimit = parseLimit
module.exports.parseSort = parseSort
module.exports.parseFields = parseFields
module.exports.stripManagedParams = stripManagedParams
module.exports.getManager = getManager
