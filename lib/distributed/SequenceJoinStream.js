/**
 * Sequence Join Stream
 *
 * A Transform stream that enriches feature documents with their sequences.
 * Batches input documents, fetches sequences from feature_sequence collection,
 * and outputs documents with sequence data attached.
 *
 * Features:
 * - Configurable batch size for efficient network usage
 * - Parallel prefetch (fetch batch N+1 while processing batch N)
 * - Proper backpressure handling
 * - Configurable sequence field (na_sequence_md5 or aa_sequence_md5)
 */

const { Transform } = require('stream')
const debug = require('debug')('p3api-server:distributed:sequence-join')

/**
 * Default configuration for sequence joining
 */
const DEFAULT_CONFIG = {
  batchSize: 200,
  prefetchBatches: 2,
  sequenceField: 'na_sequence_md5', // or 'aa_sequence_md5'
  outputField: 'sequence',
  skipHeader: true // Skip first doc (Solr metadata header)
}

class SequenceJoinStream extends Transform {
  /**
   * Create a new SequenceJoinStream.
   *
   * @param {DirectSolrClient} solrClient - Direct Solr client for sequence lookups
   * @param {Object} [options] - Configuration options
   * @param {number} [options.batchSize=200] - Number of docs to batch before lookup
   * @param {number} [options.prefetchBatches=2] - Number of batches to prefetch
   * @param {string} [options.sequenceField='na_sequence_md5'] - MD5 hash field name
   * @param {string} [options.outputField='sequence'] - Field name for attached sequence
   * @param {boolean} [options.skipHeader=true] - Skip first doc (Solr metadata header)
   */
  constructor (solrClient, options = {}) {
    super({ objectMode: true, highWaterMark: options.batchSize || DEFAULT_CONFIG.batchSize })

    if (!solrClient) {
      throw new Error('DirectSolrClient is required')
    }

    this.solrClient = solrClient
    this.config = { ...DEFAULT_CONFIG, ...options }
    this.buffer = []
    this.prefetchQueue = [] // Queue of { docs, sequencePromise }
    this.headerSkipped = !this.config.skipHeader
    this.totalDocs = 0
    this.totalSequences = 0
    this.missingSequences = 0
    this.destroyed = false

    debug(`SequenceJoinStream created: batchSize=${this.config.batchSize}, ` +
          `prefetch=${this.config.prefetchBatches}, field=${this.config.sequenceField}`)
  }

  /**
   * Extract unique MD5 hashes from documents.
   *
   * @param {Array} docs - Documents to extract from
   * @returns {Array<string>} Unique MD5 hashes (excluding nulls/undefined)
   */
  _extractHashes (docs) {
    const field = this.config.sequenceField
    const hashes = new Set()

    for (const doc of docs) {
      const hash = doc[field]
      if (hash && hash !== '') {
        hashes.add(hash)
      }
    }

    return Array.from(hashes)
  }

  /**
   * Start a prefetch for sequences.
   * Returns a promise that resolves to { md5: sequence } dictionary.
   *
   * @param {Array<string>} hashes - MD5 hashes to fetch
   * @returns {Promise<Object>} Sequence dictionary
   */
  _startPrefetch (hashes) {
    if (hashes.length === 0) {
      return Promise.resolve({})
    }

    debug(`Starting prefetch for ${hashes.length} hashes`)
    return this.solrClient.fetchSequencesByMd5(hashes)
      .catch(err => {
        debug(`Prefetch error: ${err.message}`)
        // Return empty dict on error - docs will be written without sequences
        return {}
      })
  }

  /**
   * Enrich documents with their sequences.
   *
   * @param {Array} docs - Documents to enrich
   * @param {Object} sequenceDict - MD5 to sequence mapping
   * @returns {Array} Enriched documents
   */
  _enrichDocs (docs, sequenceDict) {
    const field = this.config.sequenceField
    const outputField = this.config.outputField

    for (const doc of docs) {
      const hash = doc[field]
      if (hash && sequenceDict[hash]) {
        doc[outputField] = sequenceDict[hash]
        this.totalSequences++
      } else if (hash) {
        this.missingSequences++
        debug(`Missing sequence for hash: ${hash}`)
      }
    }

    return docs
  }

  /**
   * Process a batch: wait for prefetch, enrich, and push documents.
   *
   * @param {Object} batch - { docs, sequencePromise }
   * @param {Function} callback - Transform callback
   */
  async _processBatch (batch, callback) {
    try {
      const sequenceDict = await batch.sequencePromise
      const enrichedDocs = this._enrichDocs(batch.docs, sequenceDict)

      for (const doc of enrichedDocs) {
        this.push(doc)
      }

      this.totalDocs += batch.docs.length
      callback()
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Add current buffer to prefetch queue and start prefetch.
   */
  _queueCurrentBatch () {
    if (this.buffer.length === 0) {
      return
    }

    const docs = this.buffer
    this.buffer = []

    const hashes = this._extractHashes(docs)
    const sequencePromise = this._startPrefetch(hashes)

    this.prefetchQueue.push({ docs, sequencePromise })
  }

  /**
   * Transform implementation - buffer docs and trigger batch processing.
   */
  _transform (chunk, encoding, callback) {
    if (this.destroyed) {
      callback()
      return
    }

    // Skip first doc (Solr metadata header)
    if (!this.headerSkipped) {
      this.headerSkipped = true
      callback()
      return
    }

    this.buffer.push(chunk)

    // When buffer is full, queue for prefetch
    if (this.buffer.length >= this.config.batchSize) {
      this._queueCurrentBatch()
    }

    // If we have enough queued batches, process the oldest one
    // This creates the parallel prefetch effect
    if (this.prefetchQueue.length > this.config.prefetchBatches) {
      const batch = this.prefetchQueue.shift()
      this._processBatch(batch, callback)
    } else {
      callback()
    }
  }

  /**
   * Flush implementation - process remaining docs.
   */
  async _flush (callback) {
    if (this.destroyed) {
      callback()
      return
    }

    try {
      // Queue any remaining buffered docs
      this._queueCurrentBatch()

      // Process all queued batches
      for (const batch of this.prefetchQueue) {
        const sequenceDict = await batch.sequencePromise
        const enrichedDocs = this._enrichDocs(batch.docs, sequenceDict)

        for (const doc of enrichedDocs) {
          this.push(doc)
        }

        this.totalDocs += batch.docs.length
      }

      this.prefetchQueue = []

      debug(`SequenceJoinStream complete: ${this.totalDocs} docs, ` +
            `${this.totalSequences} sequences found, ${this.missingSequences} missing`)

      callback()
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Destroy implementation - clean up resources.
   */
  _destroy (err, callback) {
    this.destroyed = true
    this.buffer = []
    this.prefetchQueue = []
    debug('SequenceJoinStream destroyed')
    callback(err)
  }

  /**
   * Get statistics about the join operation.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    return {
      totalDocs: this.totalDocs,
      totalSequences: this.totalSequences,
      missingSequences: this.missingSequences,
      bufferSize: this.buffer.length,
      queuedBatches: this.prefetchQueue.length
    }
  }
}

/**
 * Factory function to create a SequenceJoinStream with common configurations.
 *
 * @param {DirectSolrClient} solrClient - Direct Solr client
 * @param {string} type - 'dna' or 'protein'
 * @param {Object} [options] - Additional options
 * @returns {SequenceJoinStream}
 */
function createSequenceJoinStream (solrClient, type, options = {}) {
  const typeConfig = {
    dna: { sequenceField: 'na_sequence_md5' },
    protein: { sequenceField: 'aa_sequence_md5' }
  }

  if (!typeConfig[type]) {
    throw new Error(`Unknown sequence type: ${type}. Use 'dna' or 'protein'`)
  }

  return new SequenceJoinStream(solrClient, {
    ...typeConfig[type],
    ...options
  })
}

module.exports = SequenceJoinStream
module.exports.createSequenceJoinStream = createSequenceJoinStream
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG
