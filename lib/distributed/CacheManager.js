/**
 * Cache Manager
 *
 * Simple TTL-based cache for storing expensive-to-fetch data like
 * Solr schemas and cluster status.
 */

const debug = require('debug')('p3api-server:distributed:cache')

class CacheManager {
  /**
   * Create a new cache manager.
   *
   * @param {Object} options - Cache options
   * @param {number} options.ttlMs - Time-to-live in milliseconds
   * @param {string} [options.name] - Cache name for debugging
   */
  constructor (options = {}) {
    this.ttlMs = options.ttlMs || 60000
    this.name = options.name || 'cache'
    this.cache = new Map()
    this.timestamps = new Map()
    this.hits = 0
    this.misses = 0
  }

  /**
   * Get a value from the cache.
   *
   * @param {string} key - Cache key
   * @returns {*} Cached value or undefined if not found/expired
   */
  get (key) {
    const timestamp = this.timestamps.get(key)

    if (timestamp === undefined) {
      debug(`[${this.name}] Cache miss: ${key}`)
      this.misses++
      return undefined
    }

    const age = Date.now() - timestamp
    if (age > this.ttlMs) {
      debug(`[${this.name}] Cache expired: ${key} (age: ${age}ms, ttl: ${this.ttlMs}ms)`)
      this.cache.delete(key)
      this.timestamps.delete(key)
      this.misses++
      return undefined
    }

    debug(`[${this.name}] Cache hit: ${key} (age: ${age}ms)`)
    this.hits++
    return this.cache.get(key)
  }

  /**
   * Set a value in the cache.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @returns {*} The cached value
   */
  set (key, value) {
    debug(`[${this.name}] Cache set: ${key}`)
    this.cache.set(key, value)
    this.timestamps.set(key, Date.now())
    return value
  }

  /**
   * Check if a key exists and is not expired.
   *
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists and is valid
   */
  has (key) {
    return this.get(key) !== undefined
  }

  /**
   * Invalidate a specific key.
   *
   * @param {string} key - Cache key to invalidate
   */
  invalidate (key) {
    debug(`[${this.name}] Cache invalidate: ${key}`)
    this.cache.delete(key)
    this.timestamps.delete(key)
  }

  /**
   * Clear all cached values.
   */
  clear () {
    debug(`[${this.name}] Cache clear all`)
    this.cache.clear()
    this.timestamps.clear()
  }

  /**
   * Get the number of cached items.
   *
   * @returns {number} Number of items in cache
   */
  size () {
    return this.cache.size
  }

  /**
   * Get cache statistics.
   *
   * @returns {Object} Cache statistics
   */
  stats () {
    const now = Date.now()
    let validCount = 0
    let expiredCount = 0

    for (const [key, timestamp] of this.timestamps) {
      if (now - timestamp <= this.ttlMs) {
        validCount++
      } else {
        expiredCount++
      }
    }

    return {
      name: this.name,
      ttlMs: this.ttlMs,
      size: this.cache.size,
      totalItems: this.cache.size,
      validItems: validCount,
      expiredItems: expiredCount,
      hits: this.hits,
      misses: this.misses
    }
  }

  /**
   * Get or fetch a value.
   * If the key exists in cache and is valid, return it.
   * Otherwise, call the fetcher function and cache the result.
   *
   * @param {string} key - Cache key
   * @param {Function} fetcher - Async function to fetch the value if not cached
   * @returns {Promise<*>} The cached or fetched value
   */
  async getOrFetch (key, fetcher) {
    const cached = this.get(key)
    if (cached !== undefined) {
      return cached
    }

    debug(`[${this.name}] Fetching: ${key}`)
    const value = await fetcher()
    return this.set(key, value)
  }

  /**
   * Update TTL for this cache.
   *
   * @param {number} ttlMs - New TTL in milliseconds
   */
  setTTL (ttlMs) {
    this.ttlMs = ttlMs
    debug(`[${this.name}] TTL updated to ${ttlMs}ms`)
  }

  /**
   * Get all non-expired keys.
   *
   * @returns {Array} Array of valid cache keys
   */
  keys () {
    const now = Date.now()
    const validKeys = []

    for (const [key, timestamp] of this.timestamps) {
      if (now - timestamp <= this.ttlMs) {
        validKeys.push(key)
      }
    }

    return validKeys
  }
}

module.exports = CacheManager
