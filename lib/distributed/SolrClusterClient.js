/**
 * Solr Cluster Client
 *
 * Provides access to Solr cluster metadata including:
 * - Collection schemas
 * - Cluster status and topology
 * - Shard and replica information
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const debug = require('debug')('p3api-server:distributed:cluster')

const CacheManager = require('./CacheManager')
const { getConfig } = require('./DistributedQueryConfig')
const { sanitizeUrl } = require('./utils')

class SolrClusterClient {
  /**
   * Create a new Solr cluster client.
   *
   * @param {string} solrBaseUrl - Base URL of the Solr cluster (e.g., 'http://user:pass@localhost:8983/solr')
   * @param {Object} [options] - Additional options
   * @param {Object} [options.agent] - HTTP agent for connection pooling
   */
  constructor (solrBaseUrl, options = {}) {
    this.solrBaseUrl = solrBaseUrl.replace(/\/$/, '') // Remove trailing slash
    this.agent = options.agent

    // Parse URL to determine protocol and extract auth
    const parsedUrl = new URL(this.solrBaseUrl)
    this.httpModule = parsedUrl.protocol === 'https:' ? https : http

    // Store auth credentials for shard queries
    this.auth = null
    if (parsedUrl.username && parsedUrl.password) {
      this.auth = {
        username: parsedUrl.username,
        password: parsedUrl.password
      }
      debug('Auth credentials extracted from Solr URL')
    }

    // Initialize caches
    const config = getConfig()
    this.schemaCache = new CacheManager({
      ttlMs: config.schemaCacheTTLMinutes * 60 * 1000,
      name: 'schema'
    })
    this.clusterStatusCache = new CacheManager({
      ttlMs: config.clusterStatusCacheTTLSeconds * 1000,
      name: 'clusterStatus'
    })

    debug(`SolrClusterClient initialized: ${sanitizeUrl(this.solrBaseUrl)}`)
  }

  /**
   * Make an HTTP GET request to Solr.
   *
   * @param {string} path - Request path (appended to base URL)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _request (path) {
    return new Promise((resolve, reject) => {
      const url = `${this.solrBaseUrl}${path}`
      debug(`Request: ${sanitizeUrl(url)}`)

      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }

      if (this.agent) {
        options.agent = this.agent
      }

      // Handle basic auth from URL
      if (parsedUrl.username && parsedUrl.password) {
        options.auth = `${parsedUrl.username}:${parsedUrl.password}`
      }

      const req = this.httpModule.request(options, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data)
              resolve(parsed)
            } catch (err) {
              reject(new Error(`Failed to parse JSON response from ${url}: ${err.message}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`Request failed to ${url}: ${err.message}`))
      })

      req.end()
    })
  }

  /**
   * Get the schema for a collection.
   *
   * @param {string} collection - Collection name
   * @returns {Promise<Object>} Schema object
   */
  async getSchema (collection) {
    return this.schemaCache.getOrFetch(collection, async () => {
      debug(`Fetching schema for collection: ${collection}`)
      const response = await this._request(`/${collection}/schema`)
      return response.schema
    })
  }

  /**
   * Get the unique key field for a collection.
   *
   * @param {string} collection - Collection name
   * @returns {Promise<string>} Unique key field name
   */
  async getUniqueKey (collection) {
    const schema = await this.getSchema(collection)
    return schema.uniqueKey || 'id'
  }

  /**
   * Get the cluster status.
   *
   * @returns {Promise<Object>} Cluster status object
   */
  async getClusterStatus () {
    return this.clusterStatusCache.getOrFetch('status', async () => {
      debug('Fetching cluster status')
      const response = await this._request('/admin/collections?action=CLUSTERSTATUS')
      return response.cluster
    })
  }

  /**
   * Get shard and replica information for a collection.
   *
   * @param {string} collection - Collection name
   * @returns {Promise<Array>} Array of { shard, replica } objects
   */
  async getShardsForCollection (collection) {
    const config = getConfig()
    const clusterStatus = await this.getClusterStatus()

    const collectionInfo = clusterStatus.collections[collection]
    if (!collectionInfo) {
      throw new Error(`Collection not found: ${collection}`)
    }

    const shards = collectionInfo.shards
    if (!shards || Object.keys(shards).length === 0) {
      throw new Error(`No shards found for collection: ${collection}`)
    }

    // Build exclusion regex patterns
    const excludePatterns = (config.excludeNodes || []).map(pattern => new RegExp(pattern))

    const result = []

    for (const [shardName, shardData] of Object.entries(shards)) {
      const replicas = shardData.replicas
      if (!replicas || Object.keys(replicas).length === 0) {
        debug(`No replicas for shard: ${shardName}`)
        continue
      }

      // Filter to active replicas
      let activeReplicas = Object.entries(replicas)
        .map(([replicaName, replicaData]) => ({
          name: replicaName,
          ...replicaData
        }))
        .filter(replica => replica.state === 'active')

      if (activeReplicas.length === 0) {
        debug(`No active replicas for shard: ${shardName}`)
        continue
      }

      // Filter out excluded nodes
      if (excludePatterns.length > 0) {
        activeReplicas = activeReplicas.filter(replica => {
          const baseUrl = replica.base_url || ''
          return !excludePatterns.some(pattern => pattern.test(baseUrl))
        })
      }

      if (activeReplicas.length === 0) {
        debug(`All replicas excluded for shard: ${shardName}`)
        // Throw error - we can't query this shard, which means incomplete results
        throw new Error(`No accessible replicas for shard ${shardName} in collection ${collection}. All replicas are on excluded nodes.`)
      }

      // Sort: prefer non-leaders (leader === 'false' or undefined)
      activeReplicas.sort((a, b) => {
        const aIsLeader = a.leader === 'true' || a.leader === true
        const bIsLeader = b.leader === 'true' || b.leader === true
        if (aIsLeader && !bIsLeader) return 1
        if (!aIsLeader && bIsLeader) return -1
        return 0
      })

      // Random selection among candidates with same leader status
      // to spread load across replicas
      const nonLeaders = activeReplicas.filter(r => r.leader !== 'true' && r.leader !== true)
      const candidates = nonLeaders.length > 0 ? nonLeaders : activeReplicas
      const selectedReplica = candidates[Math.floor(Math.random() * candidates.length)]

      result.push({
        shard: shardName,
        replica: selectedReplica
      })
    }

    debug(`Found ${result.length} shards for collection ${collection}`)
    return result
  }

  /**
   * Get the direct URL for querying a specific shard replica.
   * Includes authentication credentials if present in original Solr URL.
   *
   * @param {Object} replica - Replica object from getShardsForCollection
   * @returns {string} Direct query URL with auth if applicable
   */
  getReplicaQueryUrl (replica) {
    // replica.base_url is like "http://host:port/solr"
    // replica.core is the core name
    const replicaUrl = `${replica.base_url}/${replica.core}`

    // If we have auth credentials, inject them into the URL
    if (this.auth) {
      const parsed = new URL(replicaUrl)
      parsed.username = this.auth.username
      parsed.password = this.auth.password
      return parsed.toString().replace(/\/$/, '')
    }

    return replicaUrl
  }

  /**
   * Get authentication credentials from the configured Solr URL.
   *
   * @returns {Object|null} Auth object with username/password or null
   */
  getAuth () {
    return this.auth
  }

  /**
   * Invalidate the cluster status cache.
   * Call this when a shard query fails (topology may have changed).
   */
  invalidateClusterStatus () {
    debug('Invalidating cluster status cache')
    this.clusterStatusCache.invalidate('status')
  }

  /**
   * Invalidate schema cache for a collection.
   *
   * @param {string} collection - Collection name
   */
  invalidateSchema (collection) {
    debug(`Invalidating schema cache for: ${collection}`)
    this.schemaCache.invalidate(collection)
  }

  /**
   * Clear all caches.
   */
  clearCaches () {
    this.schemaCache.clear()
    this.clusterStatusCache.clear()
  }

  /**
   * Get cache statistics.
   *
   * @returns {Object} Cache statistics
   */
  getCacheStats () {
    return {
      schema: this.schemaCache.stats(),
      clusterStatus: this.clusterStatusCache.stats()
    }
  }

  /**
   * Get metrics from a specific Solr node.
   *
   * @param {string} baseUrl - Base URL of the Solr node (e.g., 'http://host:8983/solr')
   * @returns {Promise<Object>} Metrics object from Solr
   */
  async getNodeMetrics (baseUrl) {
    return new Promise((resolve, reject) => {
      const metricsUrl = `${baseUrl}/admin/metrics?group=core&group=jvm&wt=json`
      debug(`Fetching metrics from: ${sanitizeUrl(metricsUrl)}`)

      const parsedUrl = new URL(metricsUrl)
      const httpModule = parsedUrl.protocol === 'https:' ? https : http

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        timeout: 5000 // 5 second timeout for metrics
      }

      if (this.agent) {
        options.agent = this.agent
      }

      // Handle basic auth if present
      if (this.auth) {
        options.auth = `${this.auth.username}:${this.auth.password}`
      }

      const req = httpModule.request(options, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data)
              resolve(parsed.metrics || {})
            } catch (err) {
              reject(new Error(`Failed to parse metrics JSON: ${err.message}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from metrics endpoint`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`Metrics request failed: ${err.message}`))
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Metrics request timed out'))
      })

      req.end()
    })
  }

  /**
   * Extract unique node URLs from cluster status.
   *
   * @param {Object} clusterStatus - Cluster status object
   * @returns {Array<string>} Array of unique node base URLs
   */
  _extractUniqueNodeUrls (clusterStatus) {
    const nodeUrls = new Set()

    if (!clusterStatus || !clusterStatus.collections) {
      return []
    }

    for (const [, collectionInfo] of Object.entries(clusterStatus.collections)) {
      const shards = collectionInfo.shards || {}
      for (const [, shardData] of Object.entries(shards)) {
        const replicas = shardData.replicas || {}
        for (const [, replicaData] of Object.entries(replicas)) {
          if (replicaData.base_url && replicaData.state === 'active') {
            nodeUrls.add(replicaData.base_url)
          }
        }
      }
    }

    return Array.from(nodeUrls)
  }

  /**
   * Extract load metrics from raw Solr metrics response.
   *
   * @param {Object} metrics - Raw metrics object from Solr
   * @returns {Object} Extracted load metrics
   */
  _extractLoadMetrics (metrics) {
    const result = {
      queryCount: 0,
      avgQueryTimeMs: 0,
      heapUsedBytes: 0,
      heapMaxBytes: 0,
      heapUsedPercent: 0
    }

    // Extract JVM memory metrics
    const jvmMetrics = metrics['solr.jvm'] || {}
    if (jvmMetrics['memory.heap.used']) {
      result.heapUsedBytes = jvmMetrics['memory.heap.used'].value || 0
    }
    if (jvmMetrics['memory.heap.max']) {
      result.heapMaxBytes = jvmMetrics['memory.heap.max'].value || 0
    }
    if (result.heapMaxBytes > 0) {
      result.heapUsedPercent = Math.round((result.heapUsedBytes / result.heapMaxBytes) * 100)
    }

    // Extract query metrics from all cores
    let totalRequests = 0
    let totalTime = 0

    for (const [key, value] of Object.entries(metrics)) {
      if (key.startsWith('solr.core.') && value) {
        // Look for select handler metrics
        const selectRequests = value['QUERY./select.requests']
        const selectTime = value['QUERY./select.totalTime']

        if (selectRequests && typeof selectRequests.count === 'number') {
          totalRequests += selectRequests.count
        }
        if (selectTime && typeof selectTime === 'number') {
          totalTime += selectTime
        }
      }
    }

    result.queryCount = totalRequests
    if (totalRequests > 0) {
      result.avgQueryTimeMs = Math.round(totalTime / totalRequests)
    }

    return result
  }

  /**
   * Calculate average load across all nodes.
   *
   * @param {Array} nodeMetrics - Array of node metric objects
   * @returns {Object} Average load metrics
   */
  _calculateAvgLoad (nodeMetrics) {
    const healthyNodes = nodeMetrics.filter(n => n.healthy)

    if (healthyNodes.length === 0) {
      return {
        avgQueryTimeMs: 0,
        avgHeapUsedPercent: 0,
        healthyNodeCount: 0,
        totalNodeCount: nodeMetrics.length
      }
    }

    const totalQueryTime = healthyNodes.reduce((sum, n) => sum + (n.load?.avgQueryTimeMs || 0), 0)
    const totalHeapPercent = healthyNodes.reduce((sum, n) => sum + (n.load?.heapUsedPercent || 0), 0)

    return {
      avgQueryTimeMs: Math.round(totalQueryTime / healthyNodes.length),
      avgHeapUsedPercent: Math.round(totalHeapPercent / healthyNodes.length),
      healthyNodeCount: healthyNodes.length,
      totalNodeCount: nodeMetrics.length
    }
  }

  /**
   * Get load metrics for all nodes in the cluster.
   *
   * @returns {Promise<Object>} Cluster load information
   */
  async getClusterLoad () {
    const startTime = Date.now()
    debug('Fetching cluster load metrics')

    const clusterStatus = await this.getClusterStatus()
    const nodeUrls = this._extractUniqueNodeUrls(clusterStatus)

    debug(`Found ${nodeUrls.length} unique nodes for metrics collection`)

    const metrics = await Promise.all(
      nodeUrls.map(async (url) => {
        try {
          const nodeMetrics = await this.getNodeMetrics(url)
          return {
            node: sanitizeUrl(url),
            load: this._extractLoadMetrics(nodeMetrics),
            healthy: true
          }
        } catch (err) {
          debug(`Failed to get metrics from ${sanitizeUrl(url)}: ${err.message}`)
          return {
            node: sanitizeUrl(url),
            healthy: false,
            error: err.message
          }
        }
      })
    )

    const avgLoad = this._calculateAvgLoad(metrics)

    return {
      timestamp: Date.now(),
      fetchTimeMs: Date.now() - startTime,
      nodes: metrics,
      avgLoad
    }
  }

  /**
   * Update cache TTLs based on current configuration.
   * Call this after configuration changes.
   */
  updateCacheTTLs () {
    const config = getConfig()
    this.schemaCache.setTTL(config.schemaCacheTTLMinutes * 60 * 1000)
    this.clusterStatusCache.setTTL(config.clusterStatusCacheTTLSeconds * 1000)
  }
}

module.exports = SolrClusterClient
