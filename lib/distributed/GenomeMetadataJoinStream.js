/**
 * Genome Metadata Join Stream
 *
 * A Transform stream that enriches feature documents with genome-level metadata.
 * Uses an LRU cache since many features share the same genome, making lookups efficient.
 *
 * Features:
 * - LRU cache for genome metadata (configurable size)
 * - Batches cache misses for efficient network usage
 * - Configurable fields to fetch from genome collection
 * - Proper backpressure handling
 */

const { Transform } = require('stream')
const debug = require('debug')('p3api-server:distributed:genome-join')

/**
 * Simple LRU Cache implementation
 */
class LRUCache {
  constructor (maxSize = 100) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  get (key) {
    if (!this.cache.has(key)) {
      return undefined
    }
    // Move to end (most recently used)
    const value = this.cache.get(key)
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  set (key, value) {
    // Delete if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }
    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value
      this.cache.delete(oldestKey)
    }
    this.cache.set(key, value)
  }

  has (key) {
    return this.cache.has(key)
  }

  size () {
    return this.cache.size
  }

  clear () {
    this.cache.clear()
  }
}

/**
 * Default configuration for genome metadata joining
 */
const DEFAULT_CONFIG = {
  batchSize: 50, // How many docs to buffer before fetching missing genomes
  cacheSize: 100, // LRU cache size for genome metadata
  genomeIdField: 'genome_id', // Field in input docs containing genome ID
  genomeFields: [ // Fields to fetch from genome collection
    'genome_id',
    'genome_name',
    'taxon_id',
    'genome_status',
    'strain',
    'assembly_accession',
    'bioproject_accession',
    'biosample_accession'
  ],
  attachAs: 'genome_metadata', // Field name for attached metadata (null = merge at top level)
  mergeFields: false, // If true and attachAs is null, merge genome fields into doc
  skipHeader: true // Skip first doc (Solr metadata header)
}

class GenomeMetadataJoinStream extends Transform {
  /**
   * Create a new GenomeMetadataJoinStream.
   *
   * @param {DirectSolrClient} solrClient - Direct Solr client for genome lookups
   * @param {Object} [options] - Configuration options
   * @param {number} [options.batchSize=50] - Docs to buffer before lookup
   * @param {number} [options.cacheSize=100] - LRU cache size
   * @param {string} [options.genomeIdField='genome_id'] - Input field with genome ID
   * @param {Array<string>} [options.genomeFields] - Fields to fetch from genome
   * @param {string|null} [options.attachAs='genome_metadata'] - Output field name
   * @param {boolean} [options.mergeFields=false] - Merge fields at top level
   * @param {boolean} [options.skipHeader=true] - Skip first doc (Solr metadata)
   */
  constructor (solrClient, options = {}) {
    super({ objectMode: true, highWaterMark: options.batchSize || DEFAULT_CONFIG.batchSize })

    if (!solrClient) {
      throw new Error('DirectSolrClient is required')
    }

    this.solrClient = solrClient
    this.config = { ...DEFAULT_CONFIG, ...options }
    this.cache = new LRUCache(this.config.cacheSize)
    this.buffer = []
    this.headerSkipped = !this.config.skipHeader
    this.destroyed = false

    // Statistics
    this.stats = {
      totalDocs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fetchedGenomes: 0,
      missingGenomes: 0
    }

    debug(`GenomeMetadataJoinStream created: batchSize=${this.config.batchSize}, ` +
          `cacheSize=${this.config.cacheSize}, fields=${this.config.genomeFields.join(',')}`)
  }

  /**
   * Find genome IDs that are not in cache.
   *
   * @param {Array} docs - Documents to check
   * @returns {Array<string>} Genome IDs not in cache
   */
  _findMissingGenomes (docs) {
    const field = this.config.genomeIdField
    const missing = new Set()

    for (const doc of docs) {
      const genomeId = doc[field]
      if (genomeId && !this.cache.has(genomeId)) {
        missing.add(genomeId)
      }
    }

    return Array.from(missing)
  }

  /**
   * Fetch genome metadata and populate cache.
   *
   * @param {Array<string>} genomeIds - Genome IDs to fetch
   * @returns {Promise<void>}
   */
  async _fetchAndCacheGenomes (genomeIds) {
    if (genomeIds.length === 0) {
      return
    }

    debug(`Fetching ${genomeIds.length} genomes`)
    this.stats.cacheMisses += genomeIds.length

    try {
      const genomeDict = await this.solrClient.fetchGenomeMetadata(
        genomeIds,
        this.config.genomeFields
      )

      // Populate cache
      for (const [genomeId, metadata] of Object.entries(genomeDict)) {
        this.cache.set(genomeId, metadata)
        this.stats.fetchedGenomes++
      }

      // Track missing genomes
      for (const genomeId of genomeIds) {
        if (!genomeDict[genomeId]) {
          debug(`Genome not found: ${genomeId}`)
          // Cache null to avoid repeated lookups
          this.cache.set(genomeId, null)
          this.stats.missingGenomes++
        }
      }
    } catch (err) {
      debug(`Error fetching genomes: ${err.message}`)
      // Cache null for all to avoid repeated failed lookups
      for (const genomeId of genomeIds) {
        this.cache.set(genomeId, null)
        this.stats.missingGenomes++
      }
    }
  }

  /**
   * Enrich a document with genome metadata.
   *
   * @param {Object} doc - Document to enrich
   * @returns {Object} Enriched document
   */
  _enrichDoc (doc) {
    const genomeId = doc[this.config.genomeIdField]

    if (!genomeId) {
      return doc
    }

    const metadata = this.cache.get(genomeId)
    if (metadata) {
      this.stats.cacheHits++

      if (this.config.attachAs) {
        // Attach as nested object
        doc[this.config.attachAs] = metadata
      } else if (this.config.mergeFields) {
        // Merge fields at top level (with prefix to avoid conflicts)
        for (const [key, value] of Object.entries(metadata)) {
          if (key !== 'genome_id') { // Don't duplicate genome_id
            doc[`genome_${key}`] = value
          }
        }
      }
    }

    return doc
  }

  /**
   * Process buffered documents.
   *
   * @returns {Promise<void>}
   */
  async _processBuffer () {
    if (this.buffer.length === 0) {
      return
    }

    // Find genomes we need to fetch
    const missingGenomes = this._findMissingGenomes(this.buffer)

    // Fetch missing genomes
    await this._fetchAndCacheGenomes(missingGenomes)

    // Enrich and push all buffered docs
    for (const doc of this.buffer) {
      this.push(this._enrichDoc(doc))
      this.stats.totalDocs++
    }

    this.buffer = []
  }

  /**
   * Transform implementation.
   */
  async _transform (chunk, encoding, callback) {
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

    // Check if this doc's genome is already cached
    const genomeId = chunk[this.config.genomeIdField]
    if (genomeId && this.cache.has(genomeId)) {
      // Fast path: genome is cached, process immediately
      this.push(this._enrichDoc(chunk))
      this.stats.totalDocs++
      callback()
      return
    }

    // Buffer the doc
    this.buffer.push(chunk)

    // Process when buffer is full
    if (this.buffer.length >= this.config.batchSize) {
      try {
        await this._processBuffer()
        callback()
      } catch (err) {
        callback(err)
      }
    } else {
      callback()
    }
  }

  /**
   * Flush implementation.
   */
  async _flush (callback) {
    if (this.destroyed) {
      callback()
      return
    }

    try {
      await this._processBuffer()

      debug(`GenomeMetadataJoinStream complete: ${this.stats.totalDocs} docs, ` +
            `${this.stats.cacheHits} cache hits, ${this.stats.fetchedGenomes} fetched, ` +
            `${this.stats.missingGenomes} missing`)

      callback()
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Destroy implementation.
   */
  _destroy (err, callback) {
    this.destroyed = true
    this.buffer = []
    this.cache.clear()
    debug('GenomeMetadataJoinStream destroyed')
    callback(err)
  }

  /**
   * Get statistics about the join operation.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    return {
      ...this.stats,
      cacheSize: this.cache.size(),
      bufferSize: this.buffer.length,
      cacheHitRate: this.stats.cacheHits > 0
        ? Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
        : 0
    }
  }

  /**
   * Preload genomes into cache.
   * Useful when you know which genomes will be needed.
   *
   * @param {Array<string>} genomeIds - Genome IDs to preload
   * @returns {Promise<void>}
   */
  async preloadGenomes (genomeIds) {
    const missing = genomeIds.filter(id => !this.cache.has(id))
    await this._fetchAndCacheGenomes(missing)
  }
}

/**
 * Factory function to create a GenomeMetadataJoinStream.
 *
 * @param {DirectSolrClient} solrClient - Direct Solr client
 * @param {Object} [options] - Configuration options
 * @returns {GenomeMetadataJoinStream}
 */
function createGenomeMetadataJoinStream (solrClient, options = {}) {
  return new GenomeMetadataJoinStream(solrClient, options)
}

module.exports = GenomeMetadataJoinStream
module.exports.createGenomeMetadataJoinStream = createGenomeMetadataJoinStream
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG
module.exports.LRUCache = LRUCache
