/**
 * Utility functions for the distributed query module
 */

const { URL } = require('url')
const http = require('http')
const https = require('https')
const debug = require('debug')('p3api-server:distributed:utils')

/**
 * Sanitize a URL by removing username and password.
 * Used for logging to avoid exposing credentials.
 *
 * @param {string} urlString - URL that may contain credentials
 * @returns {string} URL with credentials replaced by ***
 */
function sanitizeUrl (urlString) {
  if (!urlString) return urlString

  try {
    const parsed = new URL(urlString)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : ''
      parsed.password = parsed.password ? '***' : ''
      return parsed.toString()
    }
    return urlString
  } catch (err) {
    // If URL parsing fails, try regex replacement as fallback
    // Matches user:pass@ or user@ patterns
    return urlString.replace(/\/\/[^:]+:[^@]+@/, '//***:***@').replace(/\/\/[^:@]+@/, '//***@')
  }
}

/**
 * Pre-warm shards by sending a rows=0 query to each shard.
 * This establishes connections, warms Solr caches, and returns numFound.
 *
 * @param {Array} shardConfigs - Array of { solrUrl, shard } objects
 * @param {string} query - Solr query string
 * @param {Object} [options] - Options
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @param {number} [options.maxConcurrent=50] - Max concurrent prewarm requests
 * @returns {Promise<Object>} Result with { totalFound, shardCounts, errors, elapsedMs }
 */
async function prewarmShards (shardConfigs, query, options = {}) {
  const startTime = Date.now()
  const timeout = options.timeout || 10000
  const maxConcurrent = options.maxConcurrent || 50

  debug(`Pre-warming ${shardConfigs.length} shards (maxConcurrent=${maxConcurrent})`)

  const results = {
    totalFound: 0,
    shardCounts: {},
    errors: [],
    elapsedMs: 0
  }

  // Process in batches to limit concurrency
  for (let i = 0; i < shardConfigs.length; i += maxConcurrent) {
    const batch = shardConfigs.slice(i, i + maxConcurrent)
    const promises = batch.map(config =>
      prewarmSingleShard(config, query, timeout)
        .then(result => {
          results.shardCounts[config.shard] = result.numFound
          results.totalFound += result.numFound
        })
        .catch(err => {
          debug(`Prewarm error for shard ${config.shard}: ${err.message}`)
          results.errors.push({ shard: config.shard, error: err.message })
        })
    )
    await Promise.all(promises)
  }

  results.elapsedMs = Date.now() - startTime
  debug(`Pre-warm complete: ${results.totalFound} total docs across ${Object.keys(results.shardCounts).length} shards in ${results.elapsedMs}ms`)

  return results
}

/**
 * Pre-warm a single shard with a rows=0 query.
 *
 * @param {Object} shardConfig - { solrUrl, shard }
 * @param {string} query - Solr query string
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Object>} { numFound }
 */
function prewarmSingleShard (shardConfig, query, timeout) {
  return new Promise((resolve, reject) => {
    const solrUrl = shardConfig.solrUrl.replace(/\/$/, '')

    // Build prewarm URL with rows=0
    const params = new URLSearchParams()
    params.set('rows', '0')
    params.set('shards', shardConfig.shard)
    params.set('preferLocalShards', 'true')
    params.set('wt', 'json')

    // Start with base URL
    let url = `${solrUrl}/select?${params.toString()}`

    // Append query filters - these include q= and fq= parameters
    // We don't set a default q=*:* because the query string should have it
    if (query && query.length > 0) {
      if (query.startsWith('&')) {
        url += query
      } else if (query.startsWith('?')) {
        url += '&' + query.substring(1)
      } else {
        url += '&' + query
      }
    } else {
      // No query provided, default to match all
      url += '&q=*:*'
    }

    debug(`Prewarm URL for shard ${shardConfig.shard}: ${sanitizeUrl(url.substring(0, 300))}...`)

    const parsedUrl = new URL(url)
    const httpModule = parsedUrl.protocol === 'https:' ? https : http

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeout,
      headers: {
        Accept: 'application/json'
      }
    }

    // Handle basic auth from URL
    if (parsedUrl.username && parsedUrl.password) {
      reqOptions.auth = `${parsedUrl.username}:${parsedUrl.password}`
    }

    let settled = false
    const settle = (fn, value) => {
      if (!settled) {
        settled = true
        fn(value)
      }
    }

    const req = httpModule.request(reqOptions, (res) => {
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data)
            const numFound = parsed.response?.numFound || 0
            settle(resolve, { numFound })
          } catch (err) {
            settle(reject, new Error(`Failed to parse JSON: ${err.message}`))
          }
        } else {
          settle(reject, new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`))
        }
      })
    })

    req.on('error', (err) => {
      settle(reject, new Error(`Request failed: ${err.message}`))
    })

    req.on('timeout', () => {
      req.destroy()
      settle(reject, new Error('Request timeout'))
    })

    req.end()
  })
}

module.exports = {
  sanitizeUrl,
  prewarmShards
}
