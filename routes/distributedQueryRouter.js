/**
 * Distributed Query Router
 *
 * Provides endpoints for testing and configuring distributed queries.
 *
 * Endpoints:
 * - POST /test/distributed-query - Test endpoint for distributed queries
 * - GET /test/distributed-query/config - Get current configuration
 * - PUT /test/distributed-query/config - Update configuration (admin only)
 * - GET /test/distributed-query/stats - Get manager statistics
 */

const express = require('express')
const bodyParser = require('body-parser')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const debug = require('debug')('p3api-server:route/distributed-query')
const config = require('../config')

const authMiddleware = require('../middleware/auth')
const httpParams = require('../middleware/http-params')
const RQLQueryParser = require('../middleware/RQLQueryParser')

const {
  DistributedQueryManager,
  getConfig,
  getDefaults,
  updateConfig,
  resetConfig,
  isAdminUser
} = require('../lib/distributed')

const router = express.Router({ strict: true, mergeParams: true })

// Initialize the distributed query manager
let manager = null

function getManager () {
  if (!manager) {
    const solrBaseUrl = config.get('solr').url
    if (!solrBaseUrl) {
      throw new Error('Solr URL not configured')
    }

    // Get distributed query config for SSL options
    const dqConfig = getConfig()

    manager = new DistributedQueryManager(solrBaseUrl, {
      rejectUnauthorized: dqConfig.rejectUnauthorized,
      ca: dqConfig.ca
    })
    debug(`DistributedQueryManager initialized with ${solrBaseUrl}`)
  }
  return manager
}

// Apply middleware
router.use(httpParams)
router.use(authMiddleware)

/**
 * POST /test/distributed-query
 *
 * Execute a distributed query for testing.
 *
 * Request body:
 * {
 *   "collection": "genome_feature",
 *   "query": "fq=genome_id:123&fq=feature_type:CDS",
 *   "queryType": "solr",  // or "rql"
 *   "sort": "patric_id asc",
 *   "fields": "patric_id,product,start,end",
 *   "limit": 1000,
 *   "requireSorted": false
 * }
 *
 * Response: Streams documents as newline-delimited JSON
 */
router.post('/', [
  bodyParser.json({ limit: '1mb' }),
  async function (req, res, next) {
    const startTime = Date.now()

    try {
      // Validate request
      if (!req.body.collection) {
        res.status(400).json({ error: 'collection is required' })
        return
      }
      if (!req.body.query) {
        res.status(400).json({ error: 'query is required' })
        return
      }

      // Validate collection exists
      const collections = config.get('collections')
      if (!collections.includes(req.body.collection)) {
        res.status(400).json({ error: `Unknown collection: ${req.body.collection}` })
        return
      }

      // Validate partitioning parameters
      let clientCount = null
      let clientIndex = null

      if (req.body.clientCount !== undefined) {
        clientCount = parseInt(req.body.clientCount, 10)
        if (isNaN(clientCount) || clientCount < 1) {
          res.status(400).json({ error: 'clientCount must be >= 1' })
          return
        }

        if (req.body.clientIndex === undefined) {
          res.status(400).json({
            error: 'clientIndex required when clientCount specified'
          })
          return
        }

        clientIndex = parseInt(req.body.clientIndex, 10)
        if (isNaN(clientIndex) || clientIndex < 0 || clientIndex >= clientCount) {
          res.status(400).json({
            error: `clientIndex must be in range [0, ${clientCount - 1}]`
          })
          return
        }
      }

      debug(`Distributed query request: collection=${req.body.collection}, query=${req.body.query.substring(0, 100)}...`)

      const mgr = getManager()

      // Execute query
      const result = await mgr.executeQuery({
        collection: req.body.collection,
        query: req.body.query,
        queryType: req.body.queryType || 'solr',
        sort: req.body.sort,
        fields: req.body.fields,
        limit: req.body.limit,
        requireSorted: req.body.requireSorted,
        clientCount,
        clientIndex
      })

      // Set response headers
      res.setHeader('Content-Type', 'application/x-ndjson')
      res.setHeader('X-Query-Id', result.queryId)
      res.setHeader('X-Stream-Type', result.metadata.streamType)
      res.setHeader('X-Shard-Count', result.metadata.shardCount)

      let docCount = 0

      // Transform stream that converts objects to NDJSON lines
      const ndjsonTransform = new Transform({
        objectMode: true,
        highWaterMark: 1000,
        transform (doc, encoding, callback) {
          docCount++
          callback(null, JSON.stringify(doc) + '\n')
        },
        flush (callback) {
          // Write final stats as a JSON line with special marker
          const elapsed = Date.now() - startTime
          debug(`Query ${result.queryId} complete: ${docCount} docs in ${elapsed}ms`)

          const meta = JSON.stringify({
            _meta: {
              queryId: result.queryId,
              documentCount: docCount,
              elapsedMs: elapsed,
              streamType: result.metadata.streamType,
              shardCount: result.metadata.shardCount
            }
          }) + '\n'

          callback(null, meta)
        }
      })

      // Handle client disconnect
      const handleDisconnect = () => {
        if (!res.writableEnded) {
          debug(`Query ${result.queryId}: Client disconnected, cancelling`)
          result.cancel()
        }
      }

      req.on('close', handleDisconnect)
      res.on('close', handleDisconnect)

      // Use pipeline for proper backpressure handling
      try {
        await pipeline(result.stream, ndjsonTransform, res)
      } catch (err) {
        // Pipeline errors are expected on client disconnect
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          debug(`Query ${result.queryId} pipeline error: ${err.message}`)
          if (!res.headersSent) {
            res.status(500).json({ error: err.message })
          }
        }
      }
    } catch (err) {
      debug(`Distributed query error: ${err.message}`)
      res.status(500).json({ error: err.message })
    }
  }
])

/**
 * GET /test/distributed-query/config
 *
 * Get current distributed query configuration.
 */
router.get('/config', function (req, res, next) {
  try {
    const currentConfig = getConfig()
    const defaults = getDefaults()

    res.json({
      current: currentConfig,
      defaults: defaults
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * PUT /test/distributed-query/config
 *
 * Update distributed query configuration (admin only).
 *
 * Request body: Configuration object with fields to update
 */
router.put('/config', [
  bodyParser.json(),
  function (req, res, next) {
    try {
      // Check admin authorization
      const userId = req.user ? req.user.id : null

      if (!isAdminUser(userId)) {
        res.status(403).json({ error: 'Admin access required' })
        return
      }

      debug(`Config update by ${userId}: ${JSON.stringify(req.body)}`)

      // Update configuration
      const newConfig = updateConfig(req.body)

      // Update manager caches if it exists
      if (manager) {
        manager.updateCacheTTLs()
      }

      res.json({
        success: true,
        config: newConfig
      })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  }
])

/**
 * POST /test/distributed-query/config/reset
 *
 * Reset configuration to defaults (admin only).
 */
router.post('/config/reset', function (req, res, next) {
  try {
    // Check admin authorization
    const userId = req.user ? req.user.id : null

    if (!isAdminUser(userId)) {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    debug(`Config reset by ${userId}`)

    const newConfig = resetConfig()

    // Update manager caches if it exists
    if (manager) {
      manager.updateCacheTTLs()
    }

    res.json({
      success: true,
      config: newConfig
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /test/distributed-query/stats
 *
 * Get distributed query manager statistics.
 */
router.get('/stats', function (req, res, next) {
  try {
    if (!manager) {
      res.json({
        initialized: false,
        message: 'Manager not yet initialized'
      })
      return
    }

    res.json({
      initialized: true,
      stats: manager.getStats(),
      activeQueries: manager.getActiveQueries()
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /test/distributed-query/shards/:collection
 *
 * Get shard information for a collection.
 */
router.get('/shards/:collection', async function (req, res, next) {
  try {
    const mgr = getManager()
    const shards = await mgr.getClusterClient().getShardsForCollection(req.params.collection)

    res.json({
      collection: req.params.collection,
      shardCount: shards.length,
      shards: shards.map(s => ({
        shard: s.shard,
        replica: {
          name: s.replica.name,
          core: s.replica.core,
          base_url: s.replica.base_url,
          state: s.replica.state,
          leader: s.replica.leader
        }
      }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * DELETE /test/distributed-query/cache
 *
 * Clear all caches (admin only).
 */
router.delete('/cache', function (req, res, next) {
  try {
    // Check admin authorization
    const userId = req.user ? req.user.id : null

    if (!isAdminUser(userId)) {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    if (!manager) {
      res.json({ success: true, message: 'Manager not initialized, no caches to clear' })
      return
    }

    manager.getClusterClient().clearCaches()
    debug(`Caches cleared by ${userId}`)

    res.json({ success: true, message: 'Caches cleared' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /test/distributed-query/cancel/:queryId
 *
 * Cancel an active query.
 */
router.post('/cancel/:queryId', function (req, res, next) {
  try {
    if (!manager) {
      res.status(404).json({ error: 'Manager not initialized' })
      return
    }

    const queryId = parseInt(req.params.queryId, 10)
    const cancelled = manager.cancelQuery(queryId)

    if (cancelled) {
      res.json({ success: true, message: `Query ${queryId} cancelled` })
    } else {
      res.status(404).json({ error: `Query ${queryId} not found or already completed` })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
