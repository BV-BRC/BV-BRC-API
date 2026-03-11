/**
 * Merge Sort Stream
 *
 * A k-way merge sort stream that combines sorted documents from multiple
 * shard streams into a single globally sorted output stream.
 *
 * Features:
 * - Uses a min-heap for efficient k-way merge
 * - Memory bounded (configurable max heap size)
 * - Backpressure handling (pauses shard fetches when buffer full)
 * - Supports configurable sort fields and orders
 */

const { Readable } = require('stream')
const debug = require('debug')('p3api-server:distributed:merge-sort')

const MinHeap = require('./MinHeap')
const ShardCursorStream = require('./ShardCursorStream')
const { getConfig } = require('./DistributedQueryConfig')

class MergeSortStream extends Readable {
  /**
   * Create a new merge sort stream.
   *
   * @param {Object} options - Stream options
   * @param {Array} options.shardConfigs - Array of shard configuration objects
   * @param {string} options.shardConfigs[].solrUrl - Direct URL to shard replica
   * @param {string} options.shardConfigs[].shard - Shard name
   * @param {string} options.query - Solr query string
   * @param {string} options.sort - Sort specification (e.g., 'field asc, field2 desc')
   * @param {string} [options.fields] - Comma-separated field list
   * @param {string} [options.uniqueKey='id'] - Unique key field
   * @param {Object} [options.agent] - HTTP agent for connection pooling
   * @param {number} [options.maxHeapDocs] - Override max heap size
   */
  constructor (options) {
    super({ objectMode: true, highWaterMark: 64 })

    if (!options.shardConfigs || !Array.isArray(options.shardConfigs)) {
      throw new Error('shardConfigs array is required')
    }
    if (options.shardConfigs.length === 0) {
      throw new Error('shardConfigs must not be empty')
    }
    if (!options.query) {
      throw new Error('query is required')
    }
    if (!options.sort) {
      throw new Error('sort is required for merge sort')
    }

    this.shardConfigs = [...options.shardConfigs]
    this.query = options.query
    this.sort = options.sort
    this.fields = options.fields
    this.uniqueKey = options.uniqueKey || 'id'
    this.agent = options.agent

    // Get config
    const config = getConfig()

    // Calculate minimum heap size needed: at least one batch per shard
    // to avoid deadlock when waiting for all shards to contribute
    const batchSize = config.cursorBatchSize || 2000
    const minRequiredHeapSize = this.shardConfigs.length * batchSize
    const configuredMaxHeap = options.maxHeapDocs || config.maxMergeSortHeapDocs

    // Use the larger of configured max or minimum required
    this.maxHeapDocs = Math.max(configuredMaxHeap, minRequiredHeapSize)

    if (this.maxHeapDocs > configuredMaxHeap) {
      debug(`Increased maxHeapDocs from ${configuredMaxHeap} to ${this.maxHeapDocs} for ${this.shardConfigs.length} shards`)
    }

    // Parse sort specification
    this.sortFields = this._parseSortSpec(this.sort)

    // Create comparator for the heap
    this.comparator = MinHeap.multiFieldComparator(this.sortFields)

    // State
    this.heap = new MinHeap((a, b) => this.comparator(a, b))
    this.shardStreams = new Map() // shard -> { stream, paused, exhausted }
    this.activeShards = 0
    this.started = false
    this.destroyed = false
    this.outputPaused = false

    // Track how many docs each shard has in the heap (for O(1) _canOutput check)
    this.shardDocsInHeap = new Map() // shard -> count

    // Track backpressure events for rate-limited logging
    this.backpressureCount = 0
    this.lastBackpressureLog = 0

    // Statistics
    this.stats = {
      totalDocuments: 0,
      documentsPerShard: {},
      heapPushes: 0,
      heapPops: 0
    }

    debug(`MergeSortStream created: ${this.shardConfigs.length} shards, maxHeapDocs=${this.maxHeapDocs}`)
  }

  /**
   * Parse a Solr sort specification into field/order pairs.
   *
   * @param {string} sortSpec - Sort specification (e.g., 'field asc, field2 desc')
   * @returns {Array} Array of { field, order } objects
   */
  _parseSortSpec (sortSpec) {
    const fields = []
    const parts = sortSpec.split(',')

    for (const part of parts) {
      const trimmed = part.trim()
      const match = trimmed.match(/^(\S+)\s+(asc|desc)$/i)

      if (match) {
        fields.push({
          field: match[1],
          order: match[2].toLowerCase()
        })
      } else if (trimmed) {
        // Assume ascending if no order specified
        fields.push({
          field: trimmed,
          order: 'asc'
        })
      }
    }

    if (fields.length === 0) {
      throw new Error('Invalid sort specification: no valid fields found')
    }

    return fields
  }

  /**
   * Start all shard streams and initialize the heap.
   */
  _startShards () {
    if (this.started) return
    this.started = true

    debug('Starting all shard streams')

    for (const shardConfig of this.shardConfigs) {
      const shardName = shardConfig.shard

      const stream = new ShardCursorStream({
        solrUrl: shardConfig.solrUrl,
        shard: shardName,
        query: this.query,
        sort: this.sort,
        fields: this.fields,
        uniqueKey: this.uniqueKey,
        agent: this.agent
      })

      const shardState = {
        stream,
        paused: false,
        exhausted: false,
        pendingDoc: null,
        hasContributed: false // Track if shard has contributed at least one doc
      }

      this.shardStreams.set(shardName, shardState)
      this.stats.documentsPerShard[shardName] = 0
      this.activeShards++

      // Handle data events
      stream.on('data', (doc) => {
        if (this.destroyed) return

        this.stats.documentsPerShard[shardName]++
        shardState.hasContributed = true // Mark that this shard has contributed

        // Wrap document with shard info for heap
        const heapItem = {
          doc,
          shard: shardName
        }

        // Add to heap and track shard representation
        this.heap.push(heapItem)
        this.stats.heapPushes++
        this.shardDocsInHeap.set(shardName, (this.shardDocsInHeap.get(shardName) || 0) + 1)

        // Check heap size and apply backpressure if needed
        // IMPORTANT: Never pause a shard that hasn't contributed yet,
        // otherwise we deadlock waiting for it in _canOutput()
        if (this.heap.size() >= this.maxHeapDocs && shardState.hasContributed) {
          debug(`Heap full (${this.heap.size()} docs), pausing shard: ${shardName}`)
          shardState.paused = true
          stream.pause()
        }

        // Try to output documents
        this._tryOutput()
      })

      // Handle stream end
      stream.on('end', () => {
        debug(`Shard ${shardName} exhausted`)
        shardState.exhausted = true
        this.activeShards--

        // Try to output remaining documents
        this._tryOutput()
      })

      // Handle errors
      stream.on('error', (err) => {
        debug(`Shard ${shardName} error: ${err.message}`)
        this._failAll(new Error(`Shard ${shardName} failed: ${err.message}`))
      })
    }
  }

  /**
   * Try to output documents from the heap.
   *
   * For a k-way merge sort to produce correct global order, we can only
   * output a document when we know no smaller document can arrive.
   * This means we need at least one document from each non-exhausted shard
   * in the heap, or we need to wait.
   */
  _tryOutput () {
    if (this.destroyed || this.outputPaused) return

    // Debug: log state periodically
    if (this.stats.heapPushes % 10000 === 0 && this.stats.heapPushes > 0) {
      const contributed = Array.from(this.shardStreams.values()).filter(s => s.hasContributed).length
      const exhausted = Array.from(this.shardStreams.values()).filter(s => s.exhausted).length
      debug(`_tryOutput state: heapSize=${this.heap.size()}, contributed=${contributed}/${this.shardStreams.size}, exhausted=${exhausted}, activeShards=${this.activeShards}, outputted=${this.stats.totalDocuments}`)
    }

    while (this._canOutput()) {
      const item = this.heap.pop()
      this.stats.heapPops++
      this.stats.totalDocuments++

      // Update shard representation tracking
      const count = this.shardDocsInHeap.get(item.shard) - 1
      if (count <= 0) {
        this.shardDocsInHeap.delete(item.shard)
        // IMPORTANT: If we just emptied a shard's docs from heap, resume it immediately
        // to avoid deadlock where _canOutput() waits for this shard but it's paused
        const shardState = this.shardStreams.get(item.shard)
        if (shardState && shardState.paused && !shardState.exhausted) {
          debug(`Resuming shard ${item.shard} (heap emptied of its docs)`)
          shardState.paused = false
          shardState.stream.resume()
        }
      } else {
        this.shardDocsInHeap.set(item.shard, count)
      }

      const canContinue = this.push(item.doc)

      if (!canContinue) {
        // Consumer backpressure - log only periodically to avoid spam
        this.outputPaused = true
        this.backpressureCount++
        const now = Date.now()
        if (now - this.lastBackpressureLog > 5000) { // Log at most every 5 seconds
          debug(`Output paused (backpressure #${this.backpressureCount}, outputted ${this.stats.totalDocuments} docs)`)
          this.lastBackpressureLog = now
        }
        return
      }

      // Resume paused shards if heap has room
      this._resumePausedShards()
    }

    // Check if we're done
    this._checkCompletion()
  }

  /**
   * Check if we can safely output the minimum element.
   *
   * We can output when:
   * 1. All shards are exhausted (output everything remaining), OR
   * 2. Every non-exhausted shard has at least one doc currently in the heap
   *
   * @returns {boolean} True if we can output
   */
  _canOutput () {
    if (this.heap.isEmpty()) {
      return false
    }

    // If all shards are exhausted, we can output everything
    if (this.activeShards === 0) {
      return true
    }

    // Check if every active (non-exhausted) shard has at least one doc in heap
    // Using O(1) lookup via shardDocsInHeap map instead of scanning entire heap
    for (const [shardName, state] of this.shardStreams) {
      if (!state.exhausted && !this.shardDocsInHeap.has(shardName)) {
        // An active shard has no docs in heap - can't output yet
        return false
      }
    }

    return true
  }

  /**
   * Resume paused shard streams if heap has room.
   */
  _resumePausedShards () {
    if (this.heap.size() >= this.maxHeapDocs * 0.8) {
      // Still too full, don't resume yet
      return
    }

    for (const [shardName, state] of this.shardStreams) {
      if (state.paused && !state.exhausted) {
        debug(`Resuming shard: ${shardName}`)
        state.paused = false
        state.stream.resume()
      }
    }
  }

  /**
   * Check if all shards are complete and heap is empty.
   */
  _checkCompletion () {
    if (this.destroyed) return

    if (this.activeShards === 0 && this.heap.isEmpty()) {
      debug(`Merge complete: ${this.stats.totalDocuments} total documents`)
      this.push(null)
    }
  }

  /**
   * Fail the stream and clean up all shard streams.
   *
   * @param {Error} err - The error that caused the failure
   */
  _failAll (err) {
    if (this.destroyed) return

    debug(`MergeSortStream failing: ${err.message}`)

    // Destroy all shard streams
    for (const [shardName, state] of this.shardStreams) {
      debug(`Destroying stream for shard: ${shardName}`)
      state.stream.destroy()
    }

    this.shardStreams.clear()
    this.destroy(err)
  }

  /**
   * Readable stream _read implementation.
   */
  _read () {
    // Start shards on first read
    if (!this.started) {
      this._startShards()
    }

    // Resume output if paused
    if (this.outputPaused) {
      this.outputPaused = false
      // Don't log every resume - too noisy
      this._tryOutput()
    }
  }

  /**
   * Clean up on stream destruction.
   *
   * @param {Error} err - Error if destroyed due to error
   * @param {Function} callback - Callback when cleanup is complete
   */
  _destroy (err, callback) {
    debug('MergeSortStream destroying')
    this.destroyed = true

    // Destroy all shard streams
    for (const [shardName, state] of this.shardStreams) {
      debug(`Destroying stream for shard: ${shardName}`)
      state.stream.destroy()
    }

    this.shardStreams.clear()
    this.shardDocsInHeap.clear()
    this.heap.clear()

    callback(err)
  }

  /**
   * Get stream statistics.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    const shardStats = {}
    for (const [shardName, state] of this.shardStreams) {
      shardStats[shardName] = {
        paused: state.paused,
        exhausted: state.exhausted,
        streamStats: state.stream.getStats()
      }
    }

    return {
      totalShards: this.shardConfigs.length,
      activeShards: this.activeShards,
      heapSize: this.heap.size(),
      maxHeapDocs: this.maxHeapDocs,
      totalDocuments: this.stats.totalDocuments,
      documentsPerShard: this.stats.documentsPerShard,
      heapPushes: this.stats.heapPushes,
      heapPops: this.stats.heapPops,
      shardStats
    }
  }

  /**
   * Cancel the stream and all shard queries.
   */
  cancel () {
    debug('MergeSortStream cancelled')
    this.destroy(new Error('Query cancelled'))
  }
}

module.exports = MergeSortStream
