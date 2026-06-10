/**
 * BatchJoiner - Enrichment join processor for paginated queries
 *
 * Performs efficient batch lookups to enrich documents with fields from
 * related collections. Uses an LRU cache to minimize redundant lookups
 * when documents share the same foreign keys.
 *
 * This is the non-streaming equivalent of GenomeMetadataJoinStream,
 * designed for paginated API responses rather than streaming downloads.
 */

const debug = require('debug')('p3api-server:batch-joiner')

/**
 * Simple LRU Cache implementation
 * Reused from GenomeMetadataJoinStream for consistency
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
 * BatchJoiner - Performs batch enrichment joins on document arrays
 */
class BatchJoiner {
  /**
   * Create a new BatchJoiner.
   *
   * @param {DirectSolrClient} solrClient - Direct Solr client for lookups
   * @param {Object} [config] - Configuration options
   * @param {number} [config.cacheSize=200] - LRU cache size per target collection
   */
  constructor (solrClient, config = {}) {
    if (!solrClient) {
      throw new Error('DirectSolrClient is required')
    }

    this.solrClient = solrClient
    this.cacheSize = config.cacheSize || 200

    // Per-collection caches (created on demand)
    this.caches = new Map()

    // Statistics
    this.stats = {
      totalDocs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fetched: 0,
      missing: 0
    }

    debug(`BatchJoiner created: cacheSize=${this.cacheSize}`)
  }

  /**
   * Get or create cache for a target collection.
   *
   * @param {string} collection - Target collection name
   * @returns {LRUCache} Cache for the collection
   * @private
   */
  _getCache (collection) {
    if (!this.caches.has(collection)) {
      this.caches.set(collection, new LRUCache(this.cacheSize))
    }
    return this.caches.get(collection)
  }

  /**
   * Find keys that are not in cache.
   *
   * @param {Array} docs - Documents to check
   * @param {string} localField - Field in docs containing foreign key
   * @param {LRUCache} cache - Cache to check
   * @returns {Array<string>} Keys not in cache
   * @private
   */
  _findMissingKeys (docs, localField, cache) {
    const missing = new Set()

    for (const doc of docs) {
      const key = doc[localField]
      debug(`Checking doc for ${localField}: key=${key}, inCache=${cache.has(key)}`)
      if (key && !cache.has(key)) {
        missing.add(key)
      }
    }

    debug(`Found ${missing.size} missing keys: ${Array.from(missing).join(',')}`)
    return Array.from(missing)
  }

  /**
   * Fetch documents and populate cache.
   *
   * @param {Array<string>} keys - Keys to fetch
   * @param {Object} joinSpec - Join specification
   * @param {LRUCache} cache - Cache to populate
   * @returns {Promise<void>}
   * @private
   */
  async _fetchAndCache (keys, joinSpec, cache) {
    if (keys.length === 0) {
      return
    }

    debug(`Fetching ${keys.length} records from ${joinSpec.targetCollection}`)
    this.stats.cacheMisses += keys.length

    try {
      // Build field list: always include the foreign key field plus requested fields
      const fieldsToFetch = new Set([joinSpec.foreignField, ...joinSpec.fields])
      const fl = Array.from(fieldsToFetch).join(',')

      const dict = await this.solrClient.fetchByIdsAsDict(
        joinSpec.targetCollection,
        joinSpec.foreignField,
        keys,
        { fl }
      )

      // Populate cache
      for (const [key, data] of Object.entries(dict)) {
        cache.set(key, data)
        this.stats.fetched++
      }

      // Cache null for missing keys to avoid repeated lookups
      for (const key of keys) {
        if (!dict[key]) {
          debug(`Key not found in ${joinSpec.targetCollection}: ${key}`)
          cache.set(key, null)
          this.stats.missing++
        }
      }
    } catch (err) {
      debug(`Error fetching from ${joinSpec.targetCollection}: ${err.message}`)
      // Cache null for all to avoid repeated failed lookups
      for (const key of keys) {
        cache.set(key, null)
        this.stats.missing++
      }
    }
  }

  /**
   * Enrich a single document with joined fields.
   *
   * @param {Object} doc - Document to enrich
   * @param {Object} joinSpec - Join specification
   * @param {LRUCache} cache - Cache to use
   * @returns {Object} Enriched document (mutated in place)
   * @private
   */
  _enrichDoc (doc, joinSpec, cache) {
    const key = doc[joinSpec.localField]

    if (!key) {
      return doc
    }

    const foreignData = cache.get(key)
    if (foreignData) {
      this.stats.cacheHits++

      // Flat merge: attach only the requested fields at top level
      for (const field of joinSpec.fields) {
        if (foreignData[field] !== undefined) {
          doc[field] = foreignData[field]
        }
      }
    }

    return doc
  }

  /**
   * Enrich an array of documents with fields from a related collection.
   *
   * @param {Array} docs - Documents to enrich
   * @param {Object} joinSpec - Join specification
   * @param {string} joinSpec.targetCollection - Collection to join from
   * @param {string} joinSpec.localField - Field in docs containing foreign key
   * @param {string} joinSpec.foreignField - Field in target collection to match
   * @param {Array<string>} joinSpec.fields - Fields to fetch and attach
   * @returns {Promise<Array>} Enriched documents (mutated in place)
   */
  async enrichDocs (docs, joinSpec) {
    if (!docs || docs.length === 0) {
      return docs
    }

    debug(`Enriching ${docs.length} docs with ${joinSpec.fields.join(',')} from ${joinSpec.targetCollection}`)

    const cache = this._getCache(joinSpec.targetCollection)

    // Find keys we need to fetch
    const missingKeys = this._findMissingKeys(docs, joinSpec.localField, cache)

    // Fetch missing data
    await this._fetchAndCache(missingKeys, joinSpec, cache)

    // Enrich all docs
    for (const doc of docs) {
      this._enrichDoc(doc, joinSpec, cache)
      this.stats.totalDocs++
    }

    return docs
  }

  /**
   * Get statistics about join operations.
   *
   * @returns {Object} Statistics
   */
  getStats () {
    const totalCacheSize = Array.from(this.caches.values())
      .reduce((sum, cache) => sum + cache.size(), 0)

    return {
      ...this.stats,
      cacheSize: totalCacheSize,
      cacheHitRate: this.stats.cacheHits > 0
        ? Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
        : 0
    }
  }

  /**
   * Clear all caches.
   */
  clearCache () {
    for (const cache of this.caches.values()) {
      cache.clear()
    }
    debug('All caches cleared')
  }

  /**
   * Clear cache for a specific collection.
   *
   * @param {string} collection - Collection name
   */
  clearCacheFor (collection) {
    const cache = this.caches.get(collection)
    if (cache) {
      cache.clear()
      debug(`Cache cleared for ${collection}`)
    }
  }
}

module.exports = BatchJoiner
module.exports.LRUCache = LRUCache
