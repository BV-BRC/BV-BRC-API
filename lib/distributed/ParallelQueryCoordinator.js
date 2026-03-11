/**
 * Parallel Query Coordinator
 *
 * Manages concurrent queries across multiple Solr shards with configurable
 * parallelism. Produces an unordered stream of documents from all shards.
 *
 * Features:
 * - Configurable max concurrent shard queries
 * - Automatic shard rotation as queries complete
 * - Error propagation (fail fast on persistent shard failure)
 * - Clean cancellation support
 * - Backpressure handling
 */

const { Readable } = require('stream')
const debug = require('debug')('p3api-server:distributed:coordinator')

const ShardCursorStream = require('./ShardCursorStream')
const { getConfig } = require('./DistributedQueryConfig')

class ParallelQueryCoordinator extends Readable {
  /**
   * Create a new parallel query coordinator.
   *
   * @param {Object} options - Coordinator options
   * @param {Array} options.shardConfigs - Array of shard configuration objects
   * @param {string} options.shardConfigs[].solrUrl - Direct URL to shard replica
   * @param {string} options.shardConfigs[].shard - Shard name
   * @param {string} options.query - Solr query string
   * @param {string} [options.sort] - Sort specification
   * @param {string} [options.fields] - Comma-separated field list
   * @param {string} [options.uniqueKey='id'] - Unique key field
   * @param {number} [options.maxParallelism] - Override default max parallelism
   * @param {Object} [options.agent] - HTTP agent for connection pooling
   */
  constructor (options) {
    super({ objectMode: true, highWaterMark: 1000 })

    if (!options.shardConfigs || !Array.isArray(options.shardConfigs)) {
      throw new Error('shardConfigs array is required')
    }
    if (options.shardConfigs.length === 0) {
      throw new Error('shardConfigs must not be empty')
    }
    if (!options.query) {
      throw new Error('query is required')
    }

    this.shardConfigs = [...options.shardConfigs] // Copy to avoid mutation
    this.query = options.query
    this.sort = options.sort
    this.fields = options.fields
    this.uniqueKey = options.uniqueKey || 'id'
    this.agent = options.agent

    // Get config
    const config = getConfig()
    this.maxParallelism = options.maxParallelism || config.maxParallelism

    // State
    this.pendingShards = [...this.shardConfigs] // Shards waiting to be queried
    this.activeStreams = new Map() // shard -> stream
    this.completedShards = new Set()
    this.failedShards = new Map() // shard -> error
    this.documentBuffer = []
    this.destroyed = false
    this.started = false
    this.paused = false
    this.drainScheduled = false
    this.drainBatchSize = 500 // Drain when buffer reaches this size

    // Statistics
    this.stats = {
      totalDocuments: 0,
      documentsPerShard: {}
    }

    // Handle resume event for flowing mode
    this.on('resume', () => {
      debug('Resume event received')
      if (this.paused) {
        this.paused = false
        // Resume all active shard streams
        for (const stream of this.activeStreams.values()) {
          stream.resume()
        }
        // Try to drain buffer
        this._drainBuffer()
      }
    })

    debug(`ParallelQueryCoordinator created: ${this.shardConfigs.length} shards, maxParallelism=${this.maxParallelism}`)
  }

  /**
   * Start querying shards up to the parallelism limit.
   */
  _startInitialShards () {
    if (this.started) return
    this.started = true

    const toStart = Math.min(this.maxParallelism, this.pendingShards.length)
    debug(`Starting initial ${toStart} shard queries`)

    for (let i = 0; i < toStart; i++) {
      this._startNextShard()
    }
  }

  /**
   * Start querying the next pending shard.
   */
  _startNextShard () {
    if (this.destroyed) return
    if (this.pendingShards.length === 0) return
    if (this.activeStreams.size >= this.maxParallelism) return

    const shardConfig = this.pendingShards.shift()
    const shardName = shardConfig.shard

    debug(`Starting shard query: ${shardName}`)

    const stream = new ShardCursorStream({
      solrUrl: shardConfig.solrUrl,
      shard: shardName,
      query: this.query,
      sort: this.sort,
      fields: this.fields,
      uniqueKey: this.uniqueKey,
      agent: this.agent
    })

    this.activeStreams.set(shardName, stream)
    this.stats.documentsPerShard[shardName] = 0

    // Handle data events
    stream.on('data', (doc) => {
      if (this.destroyed) return

      this.stats.totalDocuments++
      this.stats.documentsPerShard[shardName]++

      // Add shard info to document (optional, for debugging)
      // doc._shard = shardName

      this.documentBuffer.push(doc)

      // Schedule a drain if buffer is large enough or not already scheduled
      if (!this.paused && !this.drainScheduled) {
        if (this.documentBuffer.length >= this.drainBatchSize) {
          // Buffer is full enough, drain immediately
          this._drainBuffer()
        } else {
          // Schedule drain for next tick to batch more docs
          this.drainScheduled = true
          setImmediate(() => {
            this.drainScheduled = false
            if (!this.paused && !this.destroyed) {
              this._drainBuffer()
            }
          })
        }
      }
    })

    // Handle stream end
    stream.on('end', () => {
      debug(`Shard ${shardName} completed: ${this.stats.documentsPerShard[shardName]} documents`)

      this.activeStreams.delete(shardName)
      this.completedShards.add(shardName)

      // Start next shard if available
      this._startNextShard()

      // Check if all done
      this._checkCompletion()
    })

    // Handle errors
    stream.on('error', (err) => {
      debug(`Shard ${shardName} error: ${err.message}`)

      this.activeStreams.delete(shardName)
      this.failedShards.set(shardName, err)

      // Fail the entire coordinator on shard failure
      this._failAll(new Error(`Shard ${shardName} failed: ${err.message}`))
    })
  }

  /**
   * Drain the document buffer to the stream consumer.
   */
  _drainBuffer () {
    if (this.paused) {
      return
    }

    if (this.documentBuffer.length === 0) {
      return
    }

    let pushed = 0
    while (this.documentBuffer.length > 0) {
      const doc = this.documentBuffer.shift()
      const canContinue = this.push(doc)
      pushed++

      if (!canContinue) {
        // Consumer is applying backpressure
        this.paused = true
        debug(`Backpressure after pushing ${pushed} docs, buffer remaining: ${this.documentBuffer.length}`)

        // Pause all active streams
        for (const stream of this.activeStreams.values()) {
          stream.pause()
        }
        return
      }
    }

    // Only log significant drains to reduce noise
    if (pushed >= 10) {
      debug(`Drained ${pushed} docs from buffer`)
    }
  }

  /**
   * Check if all shards are complete.
   */
  _checkCompletion () {
    if (this.destroyed) return

    const allComplete =
      this.pendingShards.length === 0 &&
      this.activeStreams.size === 0

    if (allComplete) {
      debug(`All shards complete: ${this.completedShards.size} succeeded, ${this.failedShards.size} failed, ${this.stats.totalDocuments} total documents`)

      // Drain any remaining buffered documents
      this._drainBuffer()

      // End the stream
      this.push(null)
    }
  }

  /**
   * Fail the coordinator and clean up all streams.
   *
   * @param {Error} err - The error that caused the failure
   */
  _failAll (err) {
    if (this.destroyed) return

    debug(`Coordinator failing: ${err.message}`)

    // Destroy all active streams
    for (const [shardName, stream] of this.activeStreams) {
      debug(`Destroying stream for shard: ${shardName}`)
      stream.destroy()
    }

    this.activeStreams.clear()
    this.pendingShards = []

    this.destroy(err)
  }

  /**
   * Readable stream _read implementation.
   * Called when the consumer is ready for more data.
   */
  _read () {
    debug(`_read called, started=${this.started}, paused=${this.paused}, buffer=${this.documentBuffer.length}`)

    // Start shards on first read
    if (!this.started) {
      this._startInitialShards()
    }

    // Resume if we were paused
    if (this.paused) {
      this.paused = false
      debug('Resuming shard streams')

      // Resume all active streams
      for (const stream of this.activeStreams.values()) {
        stream.resume()
      }
    }

    // Drain buffer
    this._drainBuffer()
  }

  /**
   * Clean up on stream destruction.
   *
   * @param {Error} err - Error if destroyed due to error
   * @param {Function} callback - Callback when cleanup is complete
   */
  _destroy (err, callback) {
    debug('Coordinator destroying')
    this.destroyed = true

    // Destroy all active streams
    for (const [shardName, stream] of this.activeStreams) {
      debug(`Destroying stream for shard: ${shardName}`)
      stream.destroy()
    }

    this.activeStreams.clear()
    this.pendingShards = []
    this.documentBuffer = []

    callback(err)
  }

  /**
   * Get coordinator statistics.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    const activeShardStats = {}
    for (const [shardName, stream] of this.activeStreams) {
      activeShardStats[shardName] = stream.getStats()
    }

    return {
      totalShards: this.shardConfigs.length,
      pendingShards: this.pendingShards.length,
      activeShards: this.activeStreams.size,
      completedShards: this.completedShards.size,
      failedShards: this.failedShards.size,
      totalDocuments: this.stats.totalDocuments,
      documentsPerShard: this.stats.documentsPerShard,
      bufferedDocuments: this.documentBuffer.length,
      activeShardStats
    }
  }

  /**
   * Cancel the coordinator and all active queries.
   */
  cancel () {
    debug('Coordinator cancelled')
    this.destroy(new Error('Query cancelled'))
  }
}

module.exports = ParallelQueryCoordinator
