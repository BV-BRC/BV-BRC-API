/**
 * Distributed Query Manager
 *
 * High-level orchestrator for distributed queries across Solr shards.
 * Handles query planning, stream selection, and lifecycle management.
 *
 * Features:
 * - Automatic detection of sort requirements
 * - Chooses between MergeSortStream (sorted) and ParallelQueryCoordinator (unordered)
 * - RQL and Solr query support
 * - Memory usage estimation and limits
 * - Query cancellation support
 */

const http = require('http')
const https = require('https')
const fs = require('fs')
const debug = require('debug')('p3api-server:distributed:manager')

const SolrClusterClient = require('./SolrClusterClient')
const ParallelQueryCoordinator = require('./ParallelQueryCoordinator')
const MergeSortStream = require('./MergeSortStream')
const { getConfig } = require('./DistributedQueryConfig')
const { sanitizeUrl, prewarmShards } = require('./utils')

class DistributedQueryManager {
  /**
   * Create a new distributed query manager.
   *
   * @param {string} solrBaseUrl - Base URL of the Solr cluster
   * @param {Object} [options] - Manager options
   * @param {Object} [options.httpAgent] - HTTP agent for connection pooling
   * @param {Object} [options.httpsAgent] - HTTPS agent for connection pooling
   * @param {boolean} [options.rejectUnauthorized] - Set to false to accept self-signed certs (default: true)
   * @param {string} [options.ca] - CA certificate (PEM format) or path to CA file
   */
  constructor (solrBaseUrl, options = {}) {
    this.solrBaseUrl = solrBaseUrl

    // SSL/TLS options for self-signed certificates
    const tlsOptions = {}

    // Handle CA certificate
    if (options.ca) {
      // If it looks like a file path, read the file
      if (options.ca.startsWith('/') || options.ca.startsWith('./')) {
        try {
          tlsOptions.ca = fs.readFileSync(options.ca)
          debug(`Loaded CA certificate from: ${options.ca}`)
        } catch (err) {
          debug(`Warning: Could not read CA file ${options.ca}: ${err.message}`)
        }
      } else {
        // Assume it's the certificate content directly
        tlsOptions.ca = options.ca
      }
    }

    // Handle self-signed certificate acceptance
    if (options.rejectUnauthorized === false) {
      tlsOptions.rejectUnauthorized = false
      debug('Warning: SSL certificate validation disabled')
    }

    // Create connection pool agents if not provided
    this.httpAgent = options.httpAgent || new http.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10
    })

    this.httpsAgent = options.httpsAgent || new https.Agent({
      keepAlive: true,
      maxSockets: 50,
      maxFreeSockets: 10,
      ...tlsOptions
    })

    this.clusterClient = new SolrClusterClient(solrBaseUrl, {
      agent: this.solrBaseUrl.startsWith('https:') ? this.httpsAgent : this.httpAgent
    })

    // Track active queries for cleanup
    this.activeQueries = new Map()
    this.queryIdCounter = 0

    debug(`DistributedQueryManager initialized: ${sanitizeUrl(solrBaseUrl)}`)
  }

  /**
   * Execute a distributed query.
   *
   * @param {Object} options - Query options
   * @param {string} options.collection - Solr collection name
   * @param {string} options.query - Query string (RQL or Solr format)
   * @param {string} [options.queryType='solr'] - Query type: 'rql' or 'solr'
   * @param {string} [options.sort] - Sort specification
   * @param {string} [options.fields] - Comma-separated field list
   * @param {number} [options.limit] - Maximum documents to return (0 = unlimited)
   * @param {boolean} [options.requireSorted=false] - Force sorted output
   * @returns {Object} Query result with stream and metadata
   */
  async executeQuery (options) {
    if (!options.collection) {
      throw new Error('collection is required')
    }
    if (!options.query) {
      throw new Error('query is required')
    }

    const queryId = ++this.queryIdCounter
    const startTime = Date.now()

    debug(`Query ${queryId}: Starting distributed query for ${options.collection}`)

    try {
      // Get shard information
      const shardInfo = await this.clusterClient.getShardsForCollection(options.collection)

      if (shardInfo.length === 0) {
        throw new Error(`No available shards for collection: ${options.collection}`)
      }

      debug(`Query ${queryId}: Found ${shardInfo.length} shards`)

      // Apply client-side partitioning
      const partitionedShards = this._partitionShards(
        shardInfo,
        options.clientCount,
        options.clientIndex
      )

      // Handle empty partition (clientCount > shardCount case)
      if (partitionedShards.length === 0) {
        debug(`Query ${queryId}: No shards assigned to client ${options.clientIndex}/${options.clientCount}`)
        return this._createEmptyQueryResult(queryId, options)
      }

      // Get unique key for collection
      const uniqueKey = await this.clusterClient.getUniqueKey(options.collection)

      // Build shard configs with direct URLs
      const shardConfigs = partitionedShards.map(info => ({
        shard: info.shard,
        solrUrl: this.clusterClient.getReplicaQueryUrl(info.replica)
      }))

      // Determine which agent to use based on URL protocol
      const agent = this.solrBaseUrl.startsWith('https:') ? this.httpsAgent : this.httpAgent

      // Format query for Solr
      const solrQuery = this._formatQuery(options.query, options.queryType)

      // Pre-warm shards if enabled (warms caches, gets total count)
      const config = getConfig()
      let prewarmResult = null
      if (config.prewarmShards) {
        debug(`Query ${queryId}: Pre-warming ${shardConfigs.length} shards`)
        prewarmResult = await prewarmShards(shardConfigs, solrQuery, {
          timeout: config.prewarmTimeoutMs,
          maxConcurrent: config.prewarmMaxConcurrent,
          agent: agent
        })
        debug(`Query ${queryId}: Pre-warm complete - ${prewarmResult.totalFound} total docs, ${prewarmResult.elapsedMs}ms`)
        if (prewarmResult.errors.length > 0) {
          debug(`Query ${queryId}: Pre-warm had ${prewarmResult.errors.length} errors`)
        }
      }

      // Decide stream type based on sort requirement
      const needsSorted = options.requireSorted || this._hasSortRequirement(options.sort, uniqueKey)

      let stream
      let streamType
      let actualParallelism

      if (needsSorted && options.sort) {
        debug(`Query ${queryId}: Using MergeSortStream for sorted output`)
        streamType = 'merge-sort'
        // Merge sort queries all shards simultaneously
        actualParallelism = shardConfigs.length

        stream = new MergeSortStream({
          shardConfigs,
          query: solrQuery,
          sort: options.sort,
          fields: options.fields,
          uniqueKey,
          agent
        })
      } else {
        debug(`Query ${queryId}: Using ParallelQueryCoordinator for unordered output`)
        streamType = 'parallel'
        // Parallel uses configured maxParallelism
        actualParallelism = config.maxParallelism

        stream = new ParallelQueryCoordinator({
          shardConfigs,
          query: solrQuery,
          sort: options.sort,
          fields: options.fields,
          uniqueKey,
          agent
        })
      }

      // Apply limit if specified
      let outputStream = stream
      if (options.limit && options.limit > 0) {
        outputStream = this._createLimitedStream(stream, options.limit)
      }

      // Track active query
      const queryInfo = {
        id: queryId,
        collection: options.collection,
        startTime,
        streamType,
        stream,
        outputStream
      }
      this.activeQueries.set(queryId, queryInfo)

      // Clean up on stream end
      outputStream.on('end', () => {
        this._cleanupQuery(queryId)
      })
      outputStream.on('error', () => {
        this._cleanupQuery(queryId)
      })
      outputStream.on('close', () => {
        this._cleanupQuery(queryId)
      })

      debug(`Query ${queryId}: Stream created in ${Date.now() - startTime}ms`)

      return {
        queryId,
        stream: outputStream,
        metadata: {
          collection: options.collection,
          shardCount: partitionedShards.length,
          totalShards: shardInfo.length,
          streamType,
          parallelism: actualParallelism,
          sorted: needsSorted && !!options.sort,
          limit: options.limit || null,
          startTime,
          clientCount: options.clientCount || null,
          clientIndex: options.clientIndex !== undefined ? options.clientIndex : null,
          // Prewarm results (total count, timing)
          totalFound: prewarmResult ? prewarmResult.totalFound : null,
          prewarmElapsedMs: prewarmResult ? prewarmResult.elapsedMs : null,
          prewarmErrors: prewarmResult ? prewarmResult.errors.length : 0
        },
        // Methods for query management
        cancel: () => this.cancelQuery(queryId),
        getStats: () => this._getQueryStats(queryId)
      }
    } catch (err) {
      debug(`Query ${queryId}: Failed - ${err.message}`)
      throw err
    }
  }

  /**
   * Format a query for Solr based on query type.
   *
   * @param {string} query - Query string
   * @param {string} [queryType='solr'] - Query type: 'rql' or 'solr'
   * @returns {string} Formatted Solr query string
   */
  _formatQuery (query, queryType = 'solr') {
    // For now, pass through the query as-is
    // RQL conversion would happen in the middleware before reaching here
    // The query is expected to be in Solr format by this point

    if (queryType === 'rql') {
      // RQL queries should be converted by RQLQueryParser middleware
      // before reaching the distributed query manager
      debug('RQL query type specified - expecting pre-converted Solr format')
    }

    return query
  }

  /**
   * Check if a sort specification indicates sorted output is needed.
   *
   * Sorting by the unique key alone doesn't require merge-sort since
   * cursor pagination already sorts by unique key internally.
   *
   * @param {string} sort - Sort specification
   * @param {string} uniqueKey - The collection's unique key field
   * @returns {boolean} True if sorted output is required
   */
  _hasSortRequirement (sort, uniqueKey) {
    if (!sort) return false

    // Normalize the sort specification
    const trimmed = sort.trim().toLowerCase()

    // Check if sort is just the unique key (with optional direction)
    // In that case, we don't need merge sort since cursor pagination
    // already uses the unique key for ordering
    const uniqueKeyLower = (uniqueKey || 'id').toLowerCase()

    // Match patterns like "id", "id asc", "id desc", "feature_id asc", etc.
    const sortPattern = new RegExp(`^${uniqueKeyLower}(\\s+(asc|desc))?$`)
    if (sortPattern.test(trimmed)) {
      return false
    }

    return true
  }

  /**
   * Partition shards for client-side parallel querying.
   *
   * Uses round-robin distribution to assign shards to clients.
   * For example, with 8 shards and 4 clients:
   * - Client 0 gets shards [0, 4]
   * - Client 1 gets shards [1, 5]
   * - Client 2 gets shards [2, 6]
   * - Client 3 gets shards [3, 7]
   *
   * @param {Array} shards - Array of shard info objects
   * @param {number|null} clientCount - Total number of parallel clients
   * @param {number|null} clientIndex - This client's index (0-based)
   * @returns {Array} Partitioned subset of shards for this client
   */
  _partitionShards (shards, clientCount, clientIndex) {
    if (!clientCount || clientCount < 1) {
      return shards // No partitioning
    }

    // Round-robin distribution
    const partitioned = []
    for (let i = clientIndex; i < shards.length; i += clientCount) {
      partitioned.push(shards[i])
    }

    debug(`Partitioned ${shards.length} shards for client ${clientIndex}/${clientCount}: ${partitioned.length} assigned`)
    return partitioned
  }

  /**
   * Create an empty query result for cases where no shards are assigned.
   *
   * This happens when clientCount > shardCount and some clients get no shards.
   *
   * @param {number} queryId - Query ID
   * @param {Object} options - Query options
   * @returns {Object} Empty query result with empty stream
   */
  _createEmptyQueryResult (queryId, options) {
    const { Readable } = require('stream')
    const emptyStream = new Readable({
      objectMode: true,
      read () { this.push(null) }
    })

    const startTime = Date.now()
    return {
      queryId,
      stream: emptyStream,
      metadata: {
        collection: options.collection,
        shardCount: 0,
        totalShards: 0,
        streamType: 'empty',
        sorted: false,
        limit: options.limit || null,
        startTime,
        clientCount: options.clientCount || null,
        clientIndex: options.clientIndex !== undefined ? options.clientIndex : null
      },
      cancel: () => false,
      getStats: () => ({ queryId, shardCount: 0, elapsedMs: 0 })
    }
  }

  /**
   * Create a transform stream that limits output to N documents.
   *
   * @param {Readable} source - Source stream
   * @param {number} limit - Maximum documents
   * @returns {Readable} Limited stream
   */
  _createLimitedStream (source, limit) {
    const { Transform } = require('stream')
    let count = 0

    const limitStream = new Transform({
      objectMode: true,
      transform (doc, encoding, callback) {
        if (count < limit) {
          count++
          callback(null, doc)

          if (count >= limit) {
            // Destroy the source stream to stop fetching
            debug(`Limit reached (${limit}), destroying source stream`)
            source.destroy()
            this.push(null)
          }
        } else {
          callback()
        }
      }
    })

    // pipe() does not forward 'error' from source to destination. Without this,
    // a shard/coordinator failure behind the limit wrapper becomes an unhandled
    // 'error' event on the source (uncaughtException) while limitStream stalls.
    // Forward it so the error surfaces on the stream the caller actually consumes.
    source.on('error', (err) => {
      limitStream.destroy(err)
    })

    source.pipe(limitStream)
    return limitStream
  }

  /**
   * Get statistics for an active query.
   *
   * @param {number} queryId - Query ID
   * @returns {Object|null} Query statistics or null if not found
   */
  _getQueryStats (queryId) {
    const queryInfo = this.activeQueries.get(queryId)
    if (!queryInfo) return null

    return {
      queryId,
      collection: queryInfo.collection,
      streamType: queryInfo.streamType,
      elapsedMs: Date.now() - queryInfo.startTime,
      streamStats: queryInfo.stream.getStats ? queryInfo.stream.getStats() : null
    }
  }

  /**
   * Clean up a completed query.
   *
   * @param {number} queryId - Query ID
   */
  _cleanupQuery (queryId) {
    const queryInfo = this.activeQueries.get(queryId)
    if (queryInfo) {
      debug(`Query ${queryId}: Cleanup after ${Date.now() - queryInfo.startTime}ms`)
      this.activeQueries.delete(queryId)
    }
  }

  /**
   * Cancel an active query.
   *
   * @param {number} queryId - Query ID
   * @returns {boolean} True if query was found and cancelled
   */
  cancelQuery (queryId) {
    const queryInfo = this.activeQueries.get(queryId)
    if (!queryInfo) {
      // Query already completed and cleaned up - this is normal
      debug(`Query ${queryId}: Already completed (cancel request ignored)`)
      return false
    }

    debug(`Query ${queryId}: Cancelling`)

    // Destroy the underlying stream
    if (queryInfo.stream.cancel) {
      queryInfo.stream.cancel()
    } else {
      queryInfo.stream.destroy(new Error('Query cancelled'))
    }

    // Also destroy the output stream if it's different (e.g., limit wrapper)
    if (queryInfo.outputStream && queryInfo.outputStream !== queryInfo.stream) {
      queryInfo.outputStream.destroy(new Error('Query cancelled'))
    }

    // Always clean up immediately - don't rely on stream events
    this._cleanupQuery(queryId)
    return true
  }

  /**
   * Cancel all active queries.
   */
  cancelAllQueries () {
    debug(`Cancelling all ${this.activeQueries.size} active queries`)

    for (const queryId of this.activeQueries.keys()) {
      this.cancelQuery(queryId)
    }
  }

  /**
   * Get count of active queries.
   *
   * @returns {number} Number of active queries
   */
  getActiveQueryCount () {
    return this.activeQueries.size
  }

  /**
   * Get information about all active queries.
   *
   * @returns {Array} Array of query info objects
   */
  getActiveQueries () {
    const queries = []
    for (const [queryId, info] of this.activeQueries) {
      queries.push({
        queryId,
        collection: info.collection,
        streamType: info.streamType,
        elapsedMs: Date.now() - info.startTime
      })
    }
    return queries
  }

  /**
   * Get cluster client for direct access to cluster metadata.
   *
   * @returns {SolrClusterClient} Cluster client instance
   */
  getClusterClient () {
    return this.clusterClient
  }

  /**
   * Get current configuration.
   *
   * @returns {Object} Configuration object
   */
  getConfig () {
    return getConfig()
  }

  /**
   * Update cache TTLs based on current configuration.
   * Call this after configuration changes.
   */
  updateCacheTTLs () {
    this.clusterClient.updateCacheTTLs()
  }

  /**
   * Get manager statistics.
   *
   * @returns {Object} Manager statistics
   */
  getStats () {
    return {
      activeQueries: this.activeQueries.size,
      totalQueriesExecuted: this.queryIdCounter,
      cacheStats: this.clusterClient.getCacheStats()
    }
  }

  /**
   * Get cluster load metrics.
   *
   * @returns {Promise<Object>} Cluster load information
   */
  async getClusterLoad () {
    return this.clusterClient.getClusterLoad()
  }

  /**
   * Get adaptive parallelism based on current cluster load.
   *
   * Reduces parallelism when the cluster is under heavy load to avoid
   * overwhelming Solr nodes and causing cascading slowdowns.
   *
   * Thresholds:
   * - avgQueryTimeMs > 500: Reduce to 50% of configured parallelism (min 2)
   * - avgQueryTimeMs > 200: Reduce to 75% of configured parallelism (min 4)
   * - avgHeapUsedPercent > 90: Reduce to 50% of configured parallelism (min 2)
   * - avgHeapUsedPercent > 80: Reduce to 75% of configured parallelism (min 4)
   *
   * @returns {Promise<Object>} Adaptive parallelism recommendation
   */
  async getAdaptiveParallelism () {
    const config = getConfig()
    const baseParallelism = config.maxParallelism

    try {
      const clusterLoad = await this.clusterClient.getClusterLoad()
      const { avgQueryTimeMs, avgHeapUsedPercent, healthyNodeCount, totalNodeCount } = clusterLoad.avgLoad

      let recommendedParallelism = baseParallelism
      let reason = 'normal load'

      // Check for unhealthy cluster (many unreachable nodes)
      if (totalNodeCount > 0 && healthyNodeCount < totalNodeCount * 0.5) {
        recommendedParallelism = Math.max(2, Math.floor(baseParallelism / 2))
        reason = `only ${healthyNodeCount}/${totalNodeCount} nodes healthy`
      }
      // Check for high query latency
      else if (avgQueryTimeMs > 500) {
        recommendedParallelism = Math.max(2, Math.floor(baseParallelism / 2))
        reason = `high query latency (${avgQueryTimeMs}ms avg)`
      } else if (avgQueryTimeMs > 200) {
        recommendedParallelism = Math.max(4, Math.floor(baseParallelism * 0.75))
        reason = `elevated query latency (${avgQueryTimeMs}ms avg)`
      }
      // Check for high memory pressure
      else if (avgHeapUsedPercent > 90) {
        recommendedParallelism = Math.max(2, Math.floor(baseParallelism / 2))
        reason = `high heap usage (${avgHeapUsedPercent}%)`
      } else if (avgHeapUsedPercent > 80) {
        recommendedParallelism = Math.max(4, Math.floor(baseParallelism * 0.75))
        reason = `elevated heap usage (${avgHeapUsedPercent}%)`
      }

      debug(`Adaptive parallelism: ${recommendedParallelism} (base: ${baseParallelism}, reason: ${reason})`)

      return {
        configured: baseParallelism,
        recommended: recommendedParallelism,
        reason,
        clusterLoad: clusterLoad.avgLoad,
        timestamp: clusterLoad.timestamp
      }
    } catch (err) {
      // Fall back to configured parallelism if metrics unavailable
      debug(`Failed to get cluster load for adaptive parallelism: ${err.message}`)

      return {
        configured: baseParallelism,
        recommended: baseParallelism,
        reason: 'metrics unavailable, using default',
        error: err.message,
        timestamp: Date.now()
      }
    }
  }

  /**
   * Destroy the manager and clean up resources.
   */
  destroy () {
    debug('DistributedQueryManager destroying')

    this.cancelAllQueries()

    // Destroy agents if we created them
    if (this.httpAgent) {
      this.httpAgent.destroy()
    }
    if (this.httpsAgent) {
      this.httpsAgent.destroy()
    }
  }
}

module.exports = DistributedQueryManager
