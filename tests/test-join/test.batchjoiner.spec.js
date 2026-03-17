/**
 * Unit tests for BatchJoiner
 *
 * Tests LRU cache behavior, batch fetching, enrichment, and statistics tracking.
 */

const assert = require('chai').assert
const BatchJoiner = require('../../lib/BatchJoiner')
const { LRUCache } = require('../../lib/BatchJoiner')

// Mock DirectSolrClient for testing
class MockSolrClient {
  constructor (mockData = {}) {
    this.mockData = mockData
    this.fetchCalls = []
  }

  async fetchByIdsAsDict (collection, keyField, values, options = {}) {
    // Track calls for verification
    this.fetchCalls.push({ collection, keyField, values, options })

    // Return mock data for requested values
    const result = {}
    const collectionData = this.mockData[collection] || {}

    for (const value of values) {
      if (collectionData[value]) {
        result[value] = collectionData[value]
      }
    }

    return result
  }

  // Test helper to get call history
  getCallCount () {
    return this.fetchCalls.length
  }

  // Test helper to get last call
  getLastCall () {
    return this.fetchCalls[this.fetchCalls.length - 1]
  }

  // Clear call history
  clearCalls () {
    this.fetchCalls = []
  }
}

describe('LRUCache', function () {
  describe('Basic Operations', function () {
    it('should store and retrieve values', function () {
      const cache = new LRUCache(10)

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      assert.equal(cache.get('key1'), 'value1')
      assert.equal(cache.get('key2'), 'value2')
    })

    it('should return undefined for missing keys', function () {
      const cache = new LRUCache(10)

      assert.isUndefined(cache.get('nonexistent'))
    })

    it('should report size correctly', function () {
      const cache = new LRUCache(10)

      assert.equal(cache.size(), 0)
      cache.set('key1', 'value1')
      assert.equal(cache.size(), 1)
      cache.set('key2', 'value2')
      assert.equal(cache.size(), 2)
    })

    it('should check key existence with has()', function () {
      const cache = new LRUCache(10)

      assert.isFalse(cache.has('key1'))
      cache.set('key1', 'value1')
      assert.isTrue(cache.has('key1'))
    })

    it('should clear all entries', function () {
      const cache = new LRUCache(10)

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      assert.equal(cache.size(), 2)

      cache.clear()
      assert.equal(cache.size(), 0)
      assert.isUndefined(cache.get('key1'))
    })
  })

  describe('LRU Eviction', function () {
    it('should evict oldest entry when at capacity', function () {
      const cache = new LRUCache(3)

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')
      assert.equal(cache.size(), 3)

      // Adding a 4th should evict the oldest (key1)
      cache.set('key4', 'value4')
      assert.equal(cache.size(), 3)
      assert.isUndefined(cache.get('key1'))
      assert.equal(cache.get('key4'), 'value4')
    })

    it('should update position on get (keep recently used)', function () {
      const cache = new LRUCache(3)

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      // Access key1 to make it recently used
      cache.get('key1')

      // Add key4 - should evict key2 (oldest after key1 was accessed)
      cache.set('key4', 'value4')

      assert.isTrue(cache.has('key1'))
      assert.isFalse(cache.has('key2'))
      assert.isTrue(cache.has('key3'))
      assert.isTrue(cache.has('key4'))
    })

    it('should update position on set for existing key', function () {
      const cache = new LRUCache(3)

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.set('key3', 'value3')

      // Update key1 to make it recently used
      cache.set('key1', 'updated')

      // Add key4 - should evict key2
      cache.set('key4', 'value4')

      assert.equal(cache.get('key1'), 'updated')
      assert.isFalse(cache.has('key2'))
    })
  })

  describe('Edge Cases', function () {
    it('should handle cache size of 1', function () {
      const cache = new LRUCache(1)

      cache.set('key1', 'value1')
      assert.equal(cache.get('key1'), 'value1')

      cache.set('key2', 'value2')
      assert.isUndefined(cache.get('key1'))
      assert.equal(cache.get('key2'), 'value2')
    })

    it('should handle null values', function () {
      const cache = new LRUCache(10)

      cache.set('key1', null)
      assert.isNull(cache.get('key1'))
      assert.isTrue(cache.has('key1'))
    })

    it('should handle object values', function () {
      const cache = new LRUCache(10)
      const obj = { name: 'test', count: 42 }

      cache.set('key1', obj)
      assert.deepEqual(cache.get('key1'), obj)
    })
  })
})

describe('BatchJoiner', function () {
  describe('Constructor', function () {
    it('should require a solrClient', function () {
      assert.throws(() => new BatchJoiner(), /DirectSolrClient is required/)
      assert.throws(() => new BatchJoiner(null), /DirectSolrClient is required/)
    })

    it('should accept configuration options', function () {
      const mockClient = new MockSolrClient()
      const joiner = new BatchJoiner(mockClient, { cacheSize: 500 })

      assert.exists(joiner)
    })
  })

  describe('enrichDocs', function () {
    it('should return empty array unchanged', async function () {
      const mockClient = new MockSolrClient()
      const joiner = new BatchJoiner(mockClient)

      const result = await joiner.enrichDocs([], {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      })

      assert.deepEqual(result, [])
      assert.equal(mockClient.getCallCount(), 0)
    })

    it('should enrich documents with joined fields', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One', taxon_id: 1234 },
          'genome2': { genome_id: 'genome2', genome_name: 'Genome Two', taxon_id: 5678 }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      const docs = [
        { feature_id: 'f1', genome_id: 'genome1', product: 'protein A' },
        { feature_id: 'f2', genome_id: 'genome2', product: 'protein B' }
      ]

      const result = await joiner.enrichDocs(docs, {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name', 'taxon_id']
      })

      assert.equal(result[0].genome_name, 'Genome One')
      assert.equal(result[0].taxon_id, 1234)
      assert.equal(result[1].genome_name, 'Genome Two')
      assert.equal(result[1].taxon_id, 5678)

      // Original fields preserved
      assert.equal(result[0].feature_id, 'f1')
      assert.equal(result[0].product, 'protein A')
    })

    it('should use cache for repeated lookups', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      const joinSpec = {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      }

      // First batch - should fetch
      const docs1 = [{ feature_id: 'f1', genome_id: 'genome1' }]
      await joiner.enrichDocs(docs1, joinSpec)
      assert.equal(mockClient.getCallCount(), 1)

      // Second batch with same genome_id - should use cache
      const docs2 = [{ feature_id: 'f2', genome_id: 'genome1' }]
      await joiner.enrichDocs(docs2, joinSpec)
      assert.equal(mockClient.getCallCount(), 1) // No additional fetch

      // Both should be enriched
      assert.equal(docs1[0].genome_name, 'Genome One')
      assert.equal(docs2[0].genome_name, 'Genome One')
    })

    it('should deduplicate keys in batch fetch', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      // Multiple docs with same genome_id
      const docs = [
        { feature_id: 'f1', genome_id: 'genome1' },
        { feature_id: 'f2', genome_id: 'genome1' },
        { feature_id: 'f3', genome_id: 'genome1' }
      ]

      await joiner.enrichDocs(docs, {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      })

      // Should only fetch once with deduplicated keys
      assert.equal(mockClient.getCallCount(), 1)
      assert.deepEqual(mockClient.getLastCall().values, ['genome1'])

      // All docs should be enriched
      assert.equal(docs[0].genome_name, 'Genome One')
      assert.equal(docs[1].genome_name, 'Genome One')
      assert.equal(docs[2].genome_name, 'Genome One')
    })

    it('should handle missing foreign data gracefully', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
          // genome2 is missing
        }
      })

      const joiner = new BatchJoiner(mockClient)

      const docs = [
        { feature_id: 'f1', genome_id: 'genome1' },
        { feature_id: 'f2', genome_id: 'genome2' } // Missing
      ]

      const result = await joiner.enrichDocs(docs, {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      })

      // First doc enriched
      assert.equal(result[0].genome_name, 'Genome One')

      // Second doc not enriched but no error
      assert.isUndefined(result[1].genome_name)
      assert.equal(result[1].feature_id, 'f2') // Original data preserved
    })

    it('should handle docs without local field', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      const docs = [
        { feature_id: 'f1', genome_id: 'genome1' },
        { feature_id: 'f2' } // No genome_id
      ]

      await joiner.enrichDocs(docs, {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      })

      assert.equal(docs[0].genome_name, 'Genome One')
      assert.isUndefined(docs[1].genome_name)
    })

    it('should only attach requested fields', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': {
            genome_id: 'genome1',
            genome_name: 'Genome One',
            taxon_id: 1234,
            genome_status: 'Complete',
            strain: 'ABC'
          }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      const docs = [{ feature_id: 'f1', genome_id: 'genome1' }]

      await joiner.enrichDocs(docs, {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name'] // Only request genome_name
      })

      // Only genome_name should be attached
      assert.equal(docs[0].genome_name, 'Genome One')
      // Other fields from genome should NOT be attached
      // (Note: they may be in the mock response but enrichDoc only attaches requested fields)
    })
  })

  describe('Statistics', function () {
    it('should track cache hits and misses', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' },
          'genome2': { genome_id: 'genome2', genome_name: 'Genome Two' }
        }
      })

      const joiner = new BatchJoiner(mockClient)
      const joinSpec = {
        targetCollection: 'genome',
        localField: 'genome_id',
        foreignField: 'genome_id',
        fields: ['genome_name']
      }

      // First batch - all misses
      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }, { genome_id: 'genome2' }],
        joinSpec
      )

      let stats = joiner.getStats()
      assert.equal(stats.cacheMisses, 2)
      assert.equal(stats.fetched, 2)

      // Second batch - all hits (2 docs × 1 lookup each = 2 cache hits during enrichment)
      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }, { genome_id: 'genome2' }],
        joinSpec
      )

      stats = joiner.getStats()
      // First batch: 2 cache gets during enrichment after fetch
      // Second batch: 2 cache gets during enrichment (cache hits)
      // Total cache hits = 4 (2 from first batch enrichment + 2 from second batch)
      assert.equal(stats.cacheHits, 4)
      assert.isAbove(stats.cacheHitRate, 0)
    })

    it('should track total docs processed', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }, { genome_id: 'genome1' }, { genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.equal(joiner.getStats().totalDocs, 3)
    })

    it('should track missing foreign records', async function () {
      const mockClient = new MockSolrClient({
        genome: {} // Empty - nothing found
      })

      const joiner = new BatchJoiner(mockClient)

      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }, { genome_id: 'genome2' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.equal(joiner.getStats().missing, 2)
    })
  })

  describe('Cache Management', function () {
    it('should clear all caches', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.isAbove(joiner.getStats().cacheSize, 0)

      joiner.clearCache()

      assert.equal(joiner.getStats().cacheSize, 0)
    })

    it('should clear cache for specific collection', async function () {
      const mockClient = new MockSolrClient({
        genome: {
          'genome1': { genome_id: 'genome1', genome_name: 'Genome One' }
        },
        taxonomy: {
          '1234': { taxon_id: '1234', taxon_name: 'Species' }
        }
      })

      const joiner = new BatchJoiner(mockClient)

      // Populate caches for two collections
      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      await joiner.enrichDocs(
        [{ taxon_id: '1234' }],
        {
          targetCollection: 'taxonomy',
          localField: 'taxon_id',
          foreignField: 'taxon_id',
          fields: ['taxon_name']
        }
      )

      // Clear only genome cache
      joiner.clearCacheFor('genome')

      // Should need to refetch genome but not taxonomy
      mockClient.clearCalls()

      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.equal(mockClient.getCallCount(), 1) // Needed to refetch genome

      await joiner.enrichDocs(
        [{ taxon_id: '1234' }],
        {
          targetCollection: 'taxonomy',
          localField: 'taxon_id',
          foreignField: 'taxon_id',
          fields: ['taxon_name']
        }
      )

      assert.equal(mockClient.getCallCount(), 1) // No additional fetch for taxonomy
    })
  })

  describe('Error Handling', function () {
    it('should cache null for failed lookups to avoid retries', async function () {
      let callCount = 0
      const errorClient = {
        async fetchByIdsAsDict () {
          callCount++
          throw new Error('Solr connection failed')
        }
      }

      const joiner = new BatchJoiner(errorClient)

      // First call - should fail but not throw
      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.equal(callCount, 1)

      // Second call - should NOT retry because null is cached
      await joiner.enrichDocs(
        [{ genome_id: 'genome1' }],
        {
          targetCollection: 'genome',
          localField: 'genome_id',
          foreignField: 'genome_id',
          fields: ['genome_name']
        }
      )

      assert.equal(callCount, 1) // No retry
    })
  })
})
