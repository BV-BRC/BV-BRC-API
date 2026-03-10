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
