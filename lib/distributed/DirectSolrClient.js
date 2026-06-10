/**
 * Direct Solr Client
 *
 * Provides direct Solr query capability for simple collection queries.
 * Used by join streams to fetch related data (sequences, genome metadata)
 * without going through the full HTTP middleware stack.
 *
 * Unlike distributed queries, this queries a single replica directly.
 * For small, fast lookups like feature_sequence this is more efficient.
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const debug = require('debug')('p3api-server:distributed:direct-client')

const { getConfig } = require('./DistributedQueryConfig')
const { sanitizeUrl } = require('./utils')

class DirectSolrClient {
  /**
   * Create a new direct Solr client.
   *
   * @param {SolrClusterClient} clusterClient - Cluster client for replica selection
   * @param {Object} [options] - Additional options
   * @param {Object} [options.agent] - HTTP agent for connection pooling
   * @param {number} [options.timeout] - Request timeout in milliseconds (default: 30000)
   */
  constructor (clusterClient, options = {}) {
    this.clusterClient = clusterClient
    this.agent = options.agent
    this.timeout = options.timeout || 30000

    debug('DirectSolrClient initialized')
  }

  /**
   * Make a direct HTTP request to a Solr replica.
   *
   * @param {string} url - Full URL to query (with auth if needed)
   * @param {Object} [options] - Request options
   * @param {string} [options.method] - HTTP method (default: 'GET')
   * @param {string} [options.body] - Request body for POST
   * @param {Object} [options.headers] - Additional headers
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _request (url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const httpModule = parsedUrl.protocol === 'https:' ? https : http

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...options.headers
        },
        timeout: this.timeout
      }

      if (this.agent) {
        reqOptions.agent = this.agent
      }

      // Handle basic auth from URL
      if (parsedUrl.username && parsedUrl.password) {
        reqOptions.auth = `${decodeURIComponent(parsedUrl.username)}:${decodeURIComponent(parsedUrl.password)}`
      }

      if (options.body) {
        reqOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded'
        reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body)
      }

      debug(`Request: ${reqOptions.method} ${sanitizeUrl(url)}`)

      const req = httpModule.request(reqOptions, (res) => {
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
              reject(new Error(`Failed to parse JSON response: ${err.message}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`Request failed: ${err.message}`))
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timed out'))
      })

      if (options.body) {
        req.write(options.body)
      }

      req.end()
    })
  }

  /**
   * Select a random active replica for a collection.
   * Uses the cluster client's cached topology.
   *
   * @param {string} collection - Collection name
   * @returns {Promise<string>} Replica query URL with auth
   */
  async _selectReplica (collection) {
    const shards = await this.clusterClient.getShardsForCollection(collection)

    if (shards.length === 0) {
      throw new Error(`No available replicas for collection: ${collection}`)
    }

    // For simple queries (not distributed), pick a random shard's replica
    // Since data is replicated, any shard should have the full dataset
    // (This is true for non-sharded collections like feature_sequence)
    const randomShard = shards[Math.floor(Math.random() * shards.length)]
    return this.clusterClient.getReplicaQueryUrl(randomShard.replica)
  }

  /**
   * Query a collection with a Solr query string.
   *
   * @param {string} collection - Collection name
   * @param {Object} params - Solr query parameters
   * @param {string} params.q - Query string (default: '*:*')
   * @param {string} [params.fq] - Filter query
   * @param {string} [params.fl] - Field list
   * @param {number} [params.rows] - Number of rows (default: 10)
   * @param {number} [params.start] - Start offset (default: 0)
   * @param {string} [params.sort] - Sort specification
   * @returns {Promise<Object>} Solr response with response.docs array
   */
  async query (collection, params = {}) {
    const replicaUrl = await this._selectReplica(collection)

    // Build query string
    const queryParams = new URLSearchParams()
    queryParams.set('q', params.q || '*:*')
    queryParams.set('wt', 'json')
    queryParams.set('rows', String(params.rows || 10))
    queryParams.set('start', String(params.start || 0))

    if (params.fq) {
      // fq can be string or array
      if (Array.isArray(params.fq)) {
        params.fq.forEach(f => queryParams.append('fq', f))
      } else {
        queryParams.set('fq', params.fq)
      }
    }

    if (params.fl) {
      queryParams.set('fl', params.fl)
    }

    if (params.sort) {
      queryParams.set('sort', params.sort)
    }

    const url = `${replicaUrl}/select?${queryParams.toString()}`
    const response = await this._request(url)

    return response
  }

  /**
   * Fetch documents by ID (using Solr's terms query for efficiency).
   * Optimized for batch lookups by ID/MD5 hash.
   *
   * @param {string} collection - Collection name
   * @param {string} field - Field to match (e.g., 'md5', 'genome_id')
   * @param {Array<string>} values - Values to look up
   * @param {Object} [options] - Additional options
   * @param {string} [options.fl] - Field list to return
   * @returns {Promise<Array>} Array of matching documents
   */
  async fetchByIds (collection, field, values, options = {}) {
    if (!values || values.length === 0) {
      return []
    }

    const replicaUrl = await this._selectReplica(collection)
    const config = getConfig()

    // Use POST with query body for large ID lists
    // Solr has URL length limits, POST is safer for large batches
    const queryParams = new URLSearchParams()
    queryParams.set('q', '*:*')
    queryParams.set('wt', 'json')
    queryParams.set('rows', String(values.length))

    // Build fq with terms query for efficiency
    // terms query: {!terms f=md5}val1,val2,val3
    const termsQuery = `{!terms f=${field}}${values.join(',')}`
    queryParams.set('fq', termsQuery)

    if (options.fl) {
      queryParams.set('fl', options.fl)
    }

    const url = `${replicaUrl}/select`
    const response = await this._request(url, {
      method: 'POST',
      body: queryParams.toString()
    })

    return response.response?.docs || []
  }

  /**
   * Fetch documents by ID and return as a dictionary.
   * Optimized for join operations where you need to look up by key.
   *
   * @param {string} collection - Collection name
   * @param {string} keyField - Field to use as dictionary key (e.g., 'md5')
   * @param {Array<string>} values - Values to look up
   * @param {Object} [options] - Additional options
   * @param {string} [options.fl] - Field list to return
   * @param {string} [options.valueField] - If set, dictionary value is just this field
   * @returns {Promise<Object>} Dictionary mapping keyField values to docs (or valueField)
   */
  async fetchByIdsAsDict (collection, keyField, values, options = {}) {
    const docs = await this.fetchByIds(collection, keyField, values, options)

    const dict = {}
    for (const doc of docs) {
      const key = doc[keyField]
      if (key !== undefined) {
        if (options.valueField) {
          dict[key] = doc[options.valueField]
        } else {
          dict[key] = doc
        }
      }
    }

    return dict
  }

  /**
   * Fetch genome metadata by genome IDs.
   * Convenience method for GenomeMetadataJoinStream.
   *
   * @param {Array<string>} genomeIds - Genome IDs to fetch
   * @param {Array<string>} [fields] - Fields to return (default: common metadata fields)
   * @returns {Promise<Object>} Dictionary mapping genome_id to genome document
   */
  async fetchGenomeMetadata (genomeIds, fields) {
    const defaultFields = [
      'genome_id',
      'genome_name',
      'taxon_id',
      'genome_status',
      'assembly_accession',
      'bioproject_accession',
      'biosample_accession',
      'strain',
      'host_name',
      'isolation_country',
      'collection_date',
      'completion_date'
    ]

    const fl = fields ? fields.join(',') : defaultFields.join(',')

    return this.fetchByIdsAsDict('genome', 'genome_id', genomeIds, { fl })
  }

  /**
   * Fetch sequences by MD5 hashes.
   * Convenience method for SequenceJoinStream.
   *
   * @param {Array<string>} md5Hashes - MD5 hashes to look up
   * @returns {Promise<Object>} Dictionary mapping md5 to sequence string
   */
  async fetchSequencesByMd5 (md5Hashes) {
    return this.fetchByIdsAsDict('feature_sequence', 'md5', md5Hashes, {
      fl: 'md5,sequence',
      valueField: 'sequence'
    })
  }
}

module.exports = DirectSolrClient
