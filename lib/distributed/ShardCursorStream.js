/**
 * Shard Cursor Stream
 *
 * A Node.js Readable stream that queries a single Solr shard using
 * cursor-based pagination. Emits documents one at a time in object mode.
 *
 * Features:
 * - Cursor-based pagination for efficient large result sets
 * - Exponential backoff retry on failures
 * - Backpressure support (pauses fetching when consumer is slow)
 * - Direct shard querying with preferLocalShards=true
 */

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const debug = require('debug')('p3api-server:distributed:shard-cursor')

const { getConfig } = require('./DistributedQueryConfig')
const { sanitizeUrl } = require('./utils')

class ShardCursorStream extends Readable {
  /**
   * Create a new shard cursor stream.
   *
   * @param {Object} options - Stream options
   * @param {string} options.solrUrl - Direct URL to the shard replica (e.g., 'http://host:port/solr/core')
   * @param {string} options.shard - Shard name for targeting
   * @param {string} options.query - Solr query string (already formatted)
   * @param {string} [options.sort] - Sort specification (required for cursor)
   * @param {string} [options.fields] - Comma-separated field list (fl parameter)
   * @param {string} [options.uniqueKey='id'] - Unique key field for cursor
   * @param {number} [options.batchSize] - Number of docs per request
   * @param {Object} [options.agent] - HTTP agent for connection pooling
   */
  constructor (options) {
    super({ objectMode: true, highWaterMark: 16 })

    if (!options.solrUrl) {
      throw new Error('solrUrl is required')
    }
    if (!options.query) {
      throw new Error('query is required')
    }
    if (!options.shard) {
      throw new Error('shard is required')
    }

    this.solrUrl = options.solrUrl.replace(/\/$/, '')
    this.shard = options.shard
    this.query = options.query
    this.sort = options.sort
    this.fields = options.fields
    this.uniqueKey = options.uniqueKey || 'id'
    this.agent = options.agent

    // Get config
    const config = getConfig()
    this.batchSize = options.batchSize || config.cursorBatchSize
    // Use smaller initial batch for faster time-to-first-doc in merge sort scenarios
    this.initialBatchSize = options.initialBatchSize || config.initialBatchSize || 100
    this.isFirstFetch = true
    this.maxRetries = config.maxRetries
    this.initialRetryDelayMs = config.initialRetryDelayMs

    // Parse URL to determine protocol
    const parsedUrl = new URL(this.solrUrl)
    this.httpModule = parsedUrl.protocol === 'https:' ? https : http

    // Cursor state
    this.cursorMark = '*'
    this.done = false
    this.fetching = false
    this.documentBuffer = []
    this.totalFetched = 0

    // Ensure sort includes unique key for cursor pagination
    this._ensureSortHasUniqueKey()

    debug(`ShardCursorStream created: shard=${this.shard}, query=${this.query.substring(0, 100)}...`)
  }

  /**
   * Ensure sort specification includes unique key field.
   * Cursor pagination requires a sort that includes the unique key.
   */
  _ensureSortHasUniqueKey () {
    if (!this.sort) {
      // Default sort by unique key
      this.sort = `${this.uniqueKey} asc`
    } else if (!this.sort.includes(this.uniqueKey)) {
      // Append unique key to existing sort
      this.sort = `${this.sort}, ${this.uniqueKey} asc`
    }
  }

  /**
   * Build the Solr query URL with cursor parameters.
   *
   * @param {string} cursorMark - Current cursor mark
   * @returns {string} Full query URL
   */
  _buildQueryUrl (cursorMark) {
    const params = new URLSearchParams()

    // Query
    params.set('q', '*:*') // Base query, actual filter in fq or q

    // Handle the query - it may already have parameters
    // The query from RQL parser is like: &q=*:*&fq=...
    // We need to parse and merge

    // Sort (required for cursor)
    params.set('sort', this.sort)

    // Pagination - use smaller batch for first request to reduce time-to-first-doc
    const rows = this.isFirstFetch ? this.initialBatchSize : this.batchSize
    params.set('rows', rows.toString())
    params.set('cursorMark', cursorMark)

    // Shard targeting
    params.set('shards', this.shard)
    params.set('preferLocalShards', 'true')

    // Response format
    params.set('wt', 'json')

    // Field list
    if (this.fields) {
      params.set('fl', this.fields)
    }

    // Build URL - the query may contain additional parameters
    let url = `${this.solrUrl}/select?${params.toString()}`

    // Append additional query parameters (fq, etc.)
    // The this.query is expected to be in Solr format like: &fq=genome_id:123&fq=public:true
    if (this.query && this.query.length > 0) {
      // If query starts with &, append directly; otherwise add &
      if (this.query.startsWith('&')) {
        url += this.query
      } else if (this.query.startsWith('?')) {
        url += '&' + this.query.substring(1)
      } else {
        url += '&' + this.query
      }
    }

    return url
  }

  /**
   * Make an HTTP request to Solr with retry logic.
   *
   * @param {string} url - Request URL
   * @param {number} [retryCount=0] - Current retry attempt
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _requestWithRetry (url, retryCount = 0) {
    try {
      return await this._request(url)
    } catch (err) {
      if (retryCount < this.maxRetries) {
        const delay = this.initialRetryDelayMs * Math.pow(2, retryCount)
        debug(`Shard ${this.shard}: Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries}): ${err.message}`)

        await this._sleep(delay)
        return this._requestWithRetry(url, retryCount + 1)
      }

      debug(`Shard ${this.shard}: Request failed after ${this.maxRetries} retries: ${err.message}`)
      throw err
    }
  }

  /**
   * Make an HTTP request to Solr.
   *
   * @param {string} url - Request URL
   * @returns {Promise<Object>} Parsed JSON response
   */
  _request (url) {
    return new Promise((resolve, reject) => {
      debug(`Shard ${this.shard}: Request ${sanitizeUrl(url.substring(0, 200))}...`)

      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        timeout: 30000, // Connection + response timeout
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

      let settled = false
      const settle = (fn, value) => {
        if (!settled) {
          settled = true
          fn(value)
        }
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
              settle(resolve, parsed)
            } catch (err) {
              settle(reject, new Error(`Failed to parse JSON: ${err.message}`))
            }
          } else {
            settle(reject, new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`))
          }
        })
      })

      req.on('error', (err) => {
        debug(`Shard ${this.shard}: Request error: ${err.message}`)
        settle(reject, new Error(`Request failed: ${err.message}`))
      })

      req.on('timeout', () => {
        debug(`Shard ${this.shard}: Request timeout`)
        req.destroy()
        settle(reject, new Error('Request timeout'))
      })

      req.end()
    })
  }

  /**
   * Sleep for a specified duration.
   *
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Fetch the next batch of documents from Solr.
   *
   * @returns {Promise<void>}
   */
  async _fetchNextBatch () {
    if (this.done || this.fetching) {
      return
    }

    this.fetching = true

    try {
      const url = this._buildQueryUrl(this.cursorMark)
      const response = await this._requestWithRetry(url)

      // After first fetch, switch to normal batch size
      this.isFirstFetch = false

      if (!response.response) {
        throw new Error('Invalid Solr response: missing response object')
      }

      const docs = response.response.docs || []
      const nextCursorMark = response.nextCursorMark

      debug(`Shard ${this.shard}: Fetched ${docs.length} docs, total: ${this.totalFetched + docs.length}, nextCursor: ${nextCursorMark ? 'yes' : 'no'}`)

      // Add docs to buffer
      this.documentBuffer.push(...docs)
      this.totalFetched += docs.length

      // Check if we're done
      if (!nextCursorMark || nextCursorMark === this.cursorMark || docs.length === 0) {
        debug(`Shard ${this.shard}: Cursor exhausted, total fetched: ${this.totalFetched}`)
        this.done = true
      } else {
        this.cursorMark = nextCursorMark
      }
    } catch (err) {
      this.fetching = false
      this.destroy(err)
      return
    }

    this.fetching = false

    // Push buffered documents
    this._pushBufferedDocs()
  }

  /**
   * Push buffered documents to the stream.
   */
  _pushBufferedDocs () {
    let pushed = 0
    while (this.documentBuffer.length > 0) {
      const doc = this.documentBuffer.shift()
      const canContinue = this.push(doc)
      pushed++

      if (!canContinue) {
        // Consumer is applying backpressure - only log once per batch
        if (pushed > 1) {
          debug(`Shard ${this.shard}: Pushed ${pushed} docs before backpressure, ${this.documentBuffer.length} remaining`)
        }
        return
      }
    }

    // Buffer is empty - fetch more if not done
    if (this.done) {
      // No more data, end the stream
      debug(`Shard ${this.shard}: Stream complete`)
      this.push(null)
    } else if (!this.fetching) {
      // Continue fetching in background
      this._fetchNextBatch().catch(err => {
        this.destroy(err)
      })
    }
  }

  /**
   * Readable stream _read implementation.
   * Called when the consumer is ready for more data.
   */
  _read () {
    // First, push any buffered documents
    if (this.documentBuffer.length > 0) {
      this._pushBufferedDocs()
      return
    }

    // If done and buffer is empty, end stream
    if (this.done) {
      this.push(null)
      return
    }

    // Fetch more data
    this._fetchNextBatch().catch(err => {
      this.destroy(err)
    })
  }

  /**
   * Get stream statistics.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    return {
      shard: this.shard,
      totalFetched: this.totalFetched,
      buffered: this.documentBuffer.length,
      done: this.done,
      cursorMark: this.cursorMark
    }
  }
}

module.exports = ShardCursorStream
