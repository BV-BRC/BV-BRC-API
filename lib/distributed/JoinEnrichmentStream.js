/**
 * Join Enrichment Stream
 *
 * A Transform stream that enriches documents with fields from related
 * collections during streaming. Batches input documents, uses BatchJoiner
 * to fetch joined fields, and pushes enriched documents downstream.
 *
 * This provides the same enrichment as the JoinEnrichment middleware
 * but for streaming downloads (call_method === 'stream') where results
 * flow through one at a time rather than as an in-memory array.
 *
 * Features:
 * - Configurable batch size for efficient network usage
 * - Reuses BatchJoiner with its per-collection LRU cache
 * - Proper backpressure handling via Transform stream
 * - Graceful degradation — pushes unenriched docs on error
 * - Skips Solr metadata header document
 */

const { Transform } = require('stream')
const debug = require('debug')('p3api-server:distributed:join-enrichment-stream')

class JoinEnrichmentStream extends Transform {
  /**
   * Create a new JoinEnrichmentStream.
   *
   * @param {BatchJoiner} batchJoiner - BatchJoiner instance (with DirectSolrClient and caches)
   * @param {Object} [options] - Configuration options
   * @param {Array} options.joinSpecs - Array of join specifications from buildJoinSpecs()
   *   Each spec: { targetCollection, localField, foreignField, fields }
   * @param {number} [options.batchSize=50] - Number of docs to buffer before enrichment
   * @param {boolean} [options.skipHeader=true] - Skip first doc (Solr metadata header)
   * @param {string} [options.user] - Requesting user, used to scope the secondary
   *   fetches and partition the join cache. See PLAN_ENRICHMENT_PERMISSIONS.md.
   * @param {Array<string>} [options.publicFree] - Permission-exempt collection allowlist
   */
  constructor (batchJoiner, options = {}) {
    const batchSize = options.batchSize || 50
    super({ objectMode: true, highWaterMark: batchSize })

    if (!batchJoiner) {
      throw new Error('BatchJoiner is required')
    }

    this.batchJoiner = batchJoiner
    this.joinSpecs = options.joinSpecs || []
    this.joinCtx = { user: options.user, publicFree: options.publicFree }
    this.batchSize = batchSize
    this.skipHeader = options.skipHeader !== false
    this.headerSkipped = !this.skipHeader
    this.buffer = []
    this.destroyed = false

    // Statistics
    this.stats = {
      totalDocs: 0,
      enrichedDocs: 0,
      errors: 0
    }

    debug(`JoinEnrichmentStream created: ${this.joinSpecs.length} join specs, batchSize=${this.batchSize}`)
  }

  /**
   * Flush the buffer — enrich all buffered docs and push downstream.
   */
  async _flushBuffer () {
    if (this.buffer.length === 0) return

    const batch = this.buffer
    this.buffer = []

    try {
      for (const spec of this.joinSpecs) {
        debug(`Enriching batch of ${batch.length} docs from ${spec.targetCollection} via ${spec.localField}`)
        await this.batchJoiner.enrichDocs(batch, spec, this.joinCtx)
      }
      this.stats.enrichedDocs += batch.length
    } catch (err) {
      // Graceful degradation — push unenriched docs
      debug(`Enrichment error: ${err.message}`)
      this.stats.errors++
    }

    for (const doc of batch) {
      this.push(doc)
    }

    this.stats.totalDocs += batch.length
  }

  /**
   * Transform implementation — buffer docs and trigger batch enrichment.
   */
  _transform (chunk, encoding, callback) {
    if (this.destroyed) {
      callback()
      return
    }

    // Skip first doc (Solr metadata header)
    if (!this.headerSkipped) {
      this.headerSkipped = true
      this.push(chunk) // Pass header through unenriched
      callback()
      return
    }

    this.buffer.push(chunk)

    if (this.buffer.length >= this.batchSize) {
      this._flushBuffer()
        .then(() => callback())
        .catch((err) => {
          debug(`Flush error: ${err.message}`)
          callback()
        })
    } else {
      callback()
    }
  }

  /**
   * Flush implementation — process remaining buffered docs.
   */
  _flush (callback) {
    if (this.destroyed) {
      callback()
      return
    }

    this._flushBuffer()
      .then(() => {
        debug(`JoinEnrichmentStream complete: ${this.stats.totalDocs} docs, ` +
              `${this.stats.enrichedDocs} enriched, ${this.stats.errors} errors`)
        callback()
      })
      .catch((err) => {
        debug(`Final flush error: ${err.message}`)
        callback()
      })
  }

  /**
   * Destroy implementation — clean up resources.
   */
  _destroy (err, callback) {
    this.destroyed = true
    this.buffer = []
    debug('JoinEnrichmentStream destroyed')
    callback(err)
  }

  /**
   * Get statistics about the enrichment operation.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    return { ...this.stats, bufferSize: this.buffer.length }
  }
}

module.exports = JoinEnrichmentStream
