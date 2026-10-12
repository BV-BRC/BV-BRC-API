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
const { userAgent } = require('../userAgent')
const { solrHttpError, isRetriable } = require('../solrHttpError')

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
    // Separate, smaller budget for 429 backoffs — see _requestWithRetry. Kept apart from
    // maxRetries so a shedding node cannot also exhaust the connection-failure retries.
    this.maxOverloadRetries = config.maxOverloadRetries

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
   * Build the form-encoded parameters for one cursor page.
   *
   * These go in a POST body, not a query string. The caller's query carries
   * client-controlled filters, and an RQL terms()/in() clause over a few hundred
   * ids blows past Jetty's default 8 KB requestHeaderSize: as a GET, shards
   * answered `414 URI Too Long`, which reached the client as an HTTP 200
   * truncated to a single "[" — media/json.js writes the opening bracket before
   * the first document arrives, so a mid-stream shard failure cannot change the
   * status code. Measured ceiling was ~148 feature ids. DirectSolrClient.fetchByIds
   * POSTs for exactly this reason; this was the last GET in the subsystem carrying
   * a user-sized filter.
   *
   * The caller's fragment is parsed rather than concatenated. URLSearchParams
   * decodes it the same way Solr decodes a query string (`+` to space, %XX to the
   * byte) and re-encodes it for the body, so values reach Solr byte-identical to
   * what the old GET delivered — including multiple fq= and Solr local params
   * such as {!terms f=x}.
   *
   * @param {string} cursorMark - Current cursor mark
   * @returns {URLSearchParams} Parameters for the request body
   */
  _buildQueryParams (cursorMark) {
    const params = new URLSearchParams()

    // The this.query is expected to be in Solr format like: &fq=genome_id:123&fq=public:true
    const callerParams = new URLSearchParams(this.query || '')

    // Only supply the default base query when the caller's query does not already
    // carry its own q=. RQL-derived constraints may live in q= (not fq=); setting
    // q=*:* unconditionally here produced a duplicate q= and empty results.
    if (!callerParams.has('q')) {
      params.set('q', '*:*') // Base query; actual filter arrives via the caller's fq=
    }

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

    // Caller-supplied parameters last, matching the old append order. append()
    // rather than set() so repeated fq= all survive.
    for (const [name, value] of callerParams) {
      params.append(name, value)
    }

    return params
  }

  /**
   * Make an HTTP request to Solr with retry logic.
   *
   * @param {string} url - Request URL
   * @param {string} body - Form-encoded request body
   * @param {number} [retryCount=0] - Current retry attempt
   * @returns {Promise<Object>} Parsed JSON response
   */
  async _requestWithRetry (url, body, retryCount = 0, overloadRetryCount = 0) {
    try {
      return await this._request(url, body)
    } catch (err) {
      // A 429 means Solr is shedding load. Retrying it on our own backoff is the
      // opposite of what the status asks for, and because every worker does it per
      // shard it multiplies the load on a node that just said it has too much. Pace
      // these on the server's Retry-After, and count them against their own small
      // budget so they cannot consume the connection-failure retries as well.
      if (err && err.statusCode === 429) {
        if (overloadRetryCount < this.maxOverloadRetries) {
          const delay = err.retryAfterMs === null || err.retryAfterMs === undefined
            ? this.initialRetryDelayMs * Math.pow(2, overloadRetryCount)
            : err.retryAfterMs
          debug(`Shard ${this.shard}: Solr overloaded (429), backing off ${delay}ms (attempt ${overloadRetryCount + 1}/${this.maxOverloadRetries})`)
          await this._sleep(delay)
          return this._requestWithRetry(url, body, retryCount, overloadRetryCount + 1)
        }

        debug(`Shard ${this.shard}: Solr still overloaded after ${this.maxOverloadRetries} backoffs, giving up`)
        throw err
      }

      // Don't retry a request Solr refused on its merits — a 4xx will be refused
      // identically next time, so retrying only wastes the shard's capacity.
      if (!isRetriable(err)) {
        debug(`Shard ${this.shard}: Request failed with non-retriable status ${err.statusCode}: ${err.message}`)
        throw err
      }

      if (retryCount < this.maxRetries) {
        const delay = this.initialRetryDelayMs * Math.pow(2, retryCount)
        debug(`Shard ${this.shard}: Request failed, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries}): ${err.message}`)

        await this._sleep(delay)
        return this._requestWithRetry(url, body, retryCount + 1, overloadRetryCount)
      }

      debug(`Shard ${this.shard}: Request failed after ${this.maxRetries} retries: ${err.message}`)
      throw err
    }
  }

  /**
   * Make an HTTP request to Solr.
   *
   * POST with a form-encoded body — see _buildQueryParams for why this is not a GET.
   *
   * @param {string} url - Request URL
   * @param {string} body - Form-encoded request body
   * @returns {Promise<Object>} Parsed JSON response
   */
  _request (url, body) {
    return new Promise((resolve, reject) => {
      debug(`Shard ${this.shard}: Request ${sanitizeUrl(url)} (${Buffer.byteLength(body)} byte body)`)

      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        timeout: 30000, // Connection + response timeout
        headers: {
          Accept: 'application/json',
          // Every outbound request sends a UA — see the "Outbound User-Agent"
          // section in CLAUDE.md. This client was missing one.
          'User-Agent': userAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
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
            // Carries statusCode and Retry-After so the retry loop can tell a 429
            // (Solr shedding load) from a transport failure. See lib/solrHttpError.js.
            settle(reject, solrHttpError(res, data, {
              context: `Shard ${this.shard}`,
              maxBodyLength: 500
            }))
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

      req.end(body)
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
      const params = this._buildQueryParams(this.cursorMark)
      const response = await this._requestWithRetry(`${this.solrUrl}/select`, params.toString())

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
