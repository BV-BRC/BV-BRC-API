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
const { permissionContext } = require('./permissionFilter')

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
      missing: 0,
      fetchErrors: 0
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
   * Build the scope-qualified cache key for a foreign-key value.
   *
   * Cache entries MUST be partitioned by permission scope: a row fetched while
   * serving one user must never be served to another. Rows fetched under an
   * exempt/anonymous scope share the `public` prefix, preserving hit-rate for
   * the common case. See PLAN_ENRICHMENT_PERMISSIONS.md Part 2b.
   *
   * @param {string} scopeKey - Permission scope key
   * @param {string} value - Foreign key value
   * @returns {string} Scoped cache key
   * @private
   */
  _cacheKey (scopeKey, value) {
    return `${scopeKey} ${value}`
  }

  /**
   * Find keys that are not in cache.
   *
   * @param {Array} docs - Documents to check
   * @param {string} localField - Field in docs containing foreign key
   * @param {LRUCache} cache - Cache to check
   * @param {string} scopeKey - Permission scope key for cache partitioning
   * @returns {Array<string>} Keys not in cache
   * @private
   */
  _findMissingKeys (docs, localField, cache, scopeKey) {
    const missing = new Set()

    for (const doc of docs) {
      const key = doc[localField]
      if (key && !cache.has(this._cacheKey(scopeKey, key))) {
        missing.add(key)
      }
    }

    debug(`Found ${missing.size} missing keys in scope ${scopeKey}`)
    return Array.from(missing)
  }

  /**
   * Fetch documents and populate cache.
   *
   * @param {Array<string>} keys - Keys to fetch
   * @param {Object} joinSpec - Join specification
   * @param {LRUCache} cache - Cache to populate
   * @param {Object} perm - Permission context ({ permissionFq, scopeKey, user })
   * @returns {Promise<void>}
   * @private
   */
  async _fetchAndCache (keys, joinSpec, cache, perm) {
    if (keys.length === 0) {
      return
    }

    debug(`Fetching ${keys.length} records from ${joinSpec.targetCollection} (scope ${perm.scopeKey})`)
    this.stats.cacheMisses += keys.length

    try {
      // Build field list: always include the foreign key field plus requested fields
      const fieldsToFetch = new Set([joinSpec.foreignField, ...joinSpec.fields])
      const fl = Array.from(fieldsToFetch).join(',')

      const dict = await this.solrClient.fetchByIdsAsDict(
        joinSpec.targetCollection,
        joinSpec.foreignField,
        keys,
        { fl, permissionFq: perm.permissionFq, user: perm.user }
      )

      // Populate cache
      for (const [key, data] of Object.entries(dict)) {
        cache.set(this._cacheKey(perm.scopeKey, key), data)
        this.stats.fetched++
      }

      // Cache null for keys genuinely absent from the result set (either they do
      // not exist, or they are not visible in this permission scope). Correct to
      // cache: a repeat lookup in the same scope would get the same answer.
      for (const key of keys) {
        if (!dict[key]) {
          cache.set(this._cacheKey(perm.scopeKey, key), null)
          this.stats.missing++
        }
      }
    } catch (err) {
      // Do NOT cache on error. A transient Solr failure previously poisoned the
      // cache with nulls for the process lifetime, silently disabling enrichment
      // for those keys until restart. Leave the cache untouched so the next
      // request retries. See PLAN_ENRICHMENT_PERMISSIONS.md Part 2c.
      debug(`Error fetching from ${joinSpec.targetCollection} (not caching): ${err.message}`)
      this.stats.fetchErrors++
    }
  }

  /**
   * Enrich a single document with joined fields.
   *
   * @param {Object} doc - Document to enrich
   * @param {Object} joinSpec - Join specification
   * @param {LRUCache} cache - Cache to use
   * @param {string} scopeKey - Permission scope key for cache partitioning
   * @returns {Object} Enriched document (mutated in place)
   * @private
   */
  _enrichDoc (doc, joinSpec, cache, scopeKey) {
    const key = doc[joinSpec.localField]

    if (!key) {
      return doc
    }

    const foreignData = cache.get(this._cacheKey(scopeKey, key))
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
   * @param {Object} [ctx] - Requesting user's permission context
   * @param {string} [ctx.user] - Authenticated user id, if any
   * @param {Array<string>} [ctx.publicFree] - Permission-exempt collection allowlist
   * @returns {Promise<Array>} Enriched documents (mutated in place)
   */
  async enrichDocs (docs, joinSpec, ctx = {}) {
    if (!docs || docs.length === 0) {
      return docs
    }

    debug(`Enriching ${docs.length} docs with ${joinSpec.fields.join(',')} from ${joinSpec.targetCollection}`)

    // Resolve the permission filter and its matching cache scope from the same
    // inputs — these must never diverge, or rows land under the wrong scope.
    const { permissionFq, scopeKey } = permissionContext({
      collection: joinSpec.targetCollection,
      user: ctx.user,
      publicFree: ctx.publicFree
    })
    const perm = { permissionFq, scopeKey, user: ctx.user }

    const cache = this._getCache(joinSpec.targetCollection)

    // Find keys we need to fetch
    const missingKeys = this._findMissingKeys(docs, joinSpec.localField, cache, scopeKey)

    // Fetch missing data
    await this._fetchAndCache(missingKeys, joinSpec, cache, perm)

    // Enrich all docs
    for (const doc of docs) {
      this._enrichDoc(doc, joinSpec, cache, scopeKey)
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
