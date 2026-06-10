/**
 * Unit tests for CacheManager
 */

const assert = require('chai').assert
const CacheManager = require('../../lib/distributed/CacheManager')

describe('CacheManager', function () {
  describe('Basic Operations', function () {
    it('should create cache with default TTL', function () {
      const cache = new CacheManager()
      assert.isObject(cache)
    })

    it('should create cache with custom TTL', function () {
      const cache = new CacheManager({ ttlMs: 5000, name: 'test' })
      assert.isObject(cache)
    })

    it('should set and get values', function () {
      const cache = new CacheManager({ ttlMs: 60000 })
      cache.set('key1', 'value1')
      cache.set('key2', { nested: 'object' })

      assert.equal(cache.get('key1'), 'value1')
      assert.deepEqual(cache.get('key2'), { nested: 'object' })
    })

    it('should return undefined for missing keys', function () {
      const cache = new CacheManager()
      assert.isUndefined(cache.get('nonexistent'))
    })

    it('should check key existence with has()', function () {
      const cache = new CacheManager()
      cache.set('exists', 'value')

      assert.isTrue(cache.has('exists'))
      assert.isFalse(cache.has('missing'))
    })
  })

  describe('TTL Expiration', function () {
    it('should expire entries after TTL', function (done) {
      const cache = new CacheManager({ ttlMs: 50 }) // 50ms TTL
      cache.set('key', 'value')

      assert.equal(cache.get('key'), 'value')

      setTimeout(() => {
        assert.isUndefined(cache.get('key'))
        assert.isFalse(cache.has('key'))
        done()
      }, 100)
    })

    it('should not expire entries before TTL', function (done) {
      const cache = new CacheManager({ ttlMs: 200 })
      cache.set('key', 'value')

      setTimeout(() => {
        assert.equal(cache.get('key'), 'value')
        done()
      }, 50)
    })
  })

  describe('getOrFetch()', function () {
    it('should return cached value if present', async function () {
      const cache = new CacheManager({ ttlMs: 60000 })
      cache.set('key', 'cached')

      let fetchCalled = false
      const result = await cache.getOrFetch('key', async () => {
        fetchCalled = true
        return 'fetched'
      })

      assert.equal(result, 'cached')
      assert.isFalse(fetchCalled)
    })

    it('should fetch and cache if not present', async function () {
      const cache = new CacheManager({ ttlMs: 60000 })

      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return 'fetched'
      }

      const result1 = await cache.getOrFetch('key', fetcher)
      const result2 = await cache.getOrFetch('key', fetcher)

      assert.equal(result1, 'fetched')
      assert.equal(result2, 'fetched')
      assert.equal(fetchCount, 1) // Only fetched once
    })

    it('should re-fetch after expiration', async function () {
      const cache = new CacheManager({ ttlMs: 50 })

      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return `fetch-${fetchCount}`
      }

      const result1 = await cache.getOrFetch('key', fetcher)
      assert.equal(result1, 'fetch-1')

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100))

      const result2 = await cache.getOrFetch('key', fetcher)
      assert.equal(result2, 'fetch-2')
      assert.equal(fetchCount, 2)
    })

    it('should handle fetch errors', async function () {
      const cache = new CacheManager()

      const fetcher = async () => {
        throw new Error('Fetch failed')
      }

      try {
        await cache.getOrFetch('key', fetcher)
        assert.fail('Should have thrown')
      } catch (err) {
        assert.equal(err.message, 'Fetch failed')
      }

      // Key should not be cached on error
      assert.isFalse(cache.has('key'))
    })
  })

  describe('invalidate()', function () {
    it('should remove specific key', function () {
      const cache = new CacheManager()
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      cache.invalidate('key1')

      assert.isFalse(cache.has('key1'))
      assert.isTrue(cache.has('key2'))
    })

    it('should handle invalidating non-existent key', function () {
      const cache = new CacheManager()
      // Should not throw
      cache.invalidate('nonexistent')
    })
  })

  describe('clear()', function () {
    it('should remove all entries', function () {
      const cache = new CacheManager()
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      cache.clear()

      assert.isFalse(cache.has('key1'))
      assert.isFalse(cache.has('key2'))
      assert.isFalse(cache.has('key3'))
    })
  })

  describe('setTTL()', function () {
    it('should update TTL for new entries', function (done) {
      const cache = new CacheManager({ ttlMs: 500 })

      cache.setTTL(50) // Change to 50ms
      cache.set('key', 'value')

      setTimeout(() => {
        assert.isUndefined(cache.get('key'))
        done()
      }, 100)
    })
  })

  describe('stats()', function () {
    it('should return cache statistics', function () {
      const cache = new CacheManager({ name: 'test-cache' })
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      const stats = cache.stats()

      assert.equal(stats.name, 'test-cache')
      assert.equal(stats.size, 2)
      assert.isNumber(stats.ttlMs)
    })

    it('should track hits and misses', async function () {
      const cache = new CacheManager({ name: 'test' })

      // Miss
      cache.get('missing')

      // Hit
      cache.set('exists', 'value')
      cache.get('exists')
      cache.get('exists')

      const stats = cache.stats()
      assert.equal(stats.hits, 2)
      assert.equal(stats.misses, 1)
    })
  })

  describe('keys()', function () {
    it('should return all keys', function () {
      const cache = new CacheManager()
      cache.set('a', 1)
      cache.set('b', 2)
      cache.set('c', 3)

      const keys = cache.keys()
      assert.sameMembers(keys, ['a', 'b', 'c'])
    })

    it('should not include expired keys', function (done) {
      const cache = new CacheManager({ ttlMs: 50 })
      cache.set('expires', 'value')

      setTimeout(() => {
        const keys = cache.keys()
        assert.notInclude(keys, 'expires')
        done()
      }, 100)
    })
  })
})
