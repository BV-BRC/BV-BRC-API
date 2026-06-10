/**
 * Tests for DistributedQueryManager
 *
 * Tests the shard partitioning and query management functionality.
 */

const assert = require('assert')

// We need to mock the cluster client since it makes HTTP calls
const DistributedQueryManager = require('../../lib/distributed/DistributedQueryManager')

describe('DistributedQueryManager', function () {
  describe('_partitionShards()', function () {
    let manager

    before(function () {
      // Create manager with dummy URL (we won't make real requests)
      manager = new DistributedQueryManager('http://localhost:8983/solr')
    })

    after(function () {
      manager.destroy()
    })

    it('should return all shards when no partitioning', function () {
      const shards = [
        { shard: 'shard1' },
        { shard: 'shard2' },
        { shard: 'shard3' },
        { shard: 'shard4' }
      ]

      // No clientCount
      const result = manager._partitionShards(shards, null, null)
      assert.deepStrictEqual(result, shards)
    })

    it('should return all shards when clientCount is 0 or undefined', function () {
      const shards = [
        { shard: 'shard1' },
        { shard: 'shard2' }
      ]

      assert.deepStrictEqual(manager._partitionShards(shards, 0, 0), shards)
      assert.deepStrictEqual(manager._partitionShards(shards, undefined, 0), shards)
    })

    it('should return all shards when clientCount is 1', function () {
      const shards = [
        { shard: 'shard1' },
        { shard: 'shard2' },
        { shard: 'shard3' }
      ]

      const result = manager._partitionShards(shards, 1, 0)
      assert.strictEqual(result.length, 3)
      assert.deepStrictEqual(result, shards)
    })

    it('should partition evenly when shards divisible by clients', function () {
      const shards = [
        { shard: 'shard0' },
        { shard: 'shard1' },
        { shard: 'shard2' },
        { shard: 'shard3' },
        { shard: 'shard4' },
        { shard: 'shard5' },
        { shard: 'shard6' },
        { shard: 'shard7' }
      ]

      // 8 shards, 4 clients = 2 shards each
      const client0 = manager._partitionShards(shards, 4, 0)
      const client1 = manager._partitionShards(shards, 4, 1)
      const client2 = manager._partitionShards(shards, 4, 2)
      const client3 = manager._partitionShards(shards, 4, 3)

      assert.strictEqual(client0.length, 2)
      assert.strictEqual(client1.length, 2)
      assert.strictEqual(client2.length, 2)
      assert.strictEqual(client3.length, 2)

      // Check round-robin assignment
      assert.strictEqual(client0[0].shard, 'shard0')
      assert.strictEqual(client0[1].shard, 'shard4')
      assert.strictEqual(client1[0].shard, 'shard1')
      assert.strictEqual(client1[1].shard, 'shard5')
      assert.strictEqual(client2[0].shard, 'shard2')
      assert.strictEqual(client2[1].shard, 'shard6')
      assert.strictEqual(client3[0].shard, 'shard3')
      assert.strictEqual(client3[1].shard, 'shard7')
    })

    it('should partition unevenly when shards not divisible by clients', function () {
      const shards = [
        { shard: 'shard0' },
        { shard: 'shard1' },
        { shard: 'shard2' },
        { shard: 'shard3' },
        { shard: 'shard4' }
      ]

      // 5 shards, 3 clients = 2, 2, 1 shards
      const client0 = manager._partitionShards(shards, 3, 0)
      const client1 = manager._partitionShards(shards, 3, 1)
      const client2 = manager._partitionShards(shards, 3, 2)

      assert.strictEqual(client0.length, 2)
      assert.strictEqual(client1.length, 2)
      assert.strictEqual(client2.length, 1)

      // Check round-robin assignment
      assert.strictEqual(client0[0].shard, 'shard0')
      assert.strictEqual(client0[1].shard, 'shard3')
      assert.strictEqual(client1[0].shard, 'shard1')
      assert.strictEqual(client1[1].shard, 'shard4')
      assert.strictEqual(client2[0].shard, 'shard2')
    })

    it('should return empty array when clientCount > shardCount', function () {
      const shards = [
        { shard: 'shard0' },
        { shard: 'shard1' }
      ]

      // 2 shards, 4 clients
      const client0 = manager._partitionShards(shards, 4, 0)
      const client1 = manager._partitionShards(shards, 4, 1)
      const client2 = manager._partitionShards(shards, 4, 2)
      const client3 = manager._partitionShards(shards, 4, 3)

      assert.strictEqual(client0.length, 1)
      assert.strictEqual(client1.length, 1)
      assert.strictEqual(client2.length, 0)
      assert.strictEqual(client3.length, 0)

      assert.strictEqual(client0[0].shard, 'shard0')
      assert.strictEqual(client1[0].shard, 'shard1')
    })

    it('should handle single shard with multiple clients', function () {
      const shards = [{ shard: 'shard0' }]

      // 1 shard, 3 clients - only first client gets the shard
      const client0 = manager._partitionShards(shards, 3, 0)
      const client1 = manager._partitionShards(shards, 3, 1)
      const client2 = manager._partitionShards(shards, 3, 2)

      assert.strictEqual(client0.length, 1)
      assert.strictEqual(client1.length, 0)
      assert.strictEqual(client2.length, 0)
    })

    it('should ensure all shards are covered exactly once', function () {
      const shards = [
        { shard: 'shard0' },
        { shard: 'shard1' },
        { shard: 'shard2' },
        { shard: 'shard3' },
        { shard: 'shard4' },
        { shard: 'shard5' },
        { shard: 'shard6' }
      ]

      // 7 shards, 4 clients
      const allAssigned = []
      for (let i = 0; i < 4; i++) {
        const assigned = manager._partitionShards(shards, 4, i)
        allAssigned.push(...assigned.map(s => s.shard))
      }

      // Sort and compare - all shards should appear exactly once
      allAssigned.sort()
      assert.deepStrictEqual(
        allAssigned,
        ['shard0', 'shard1', 'shard2', 'shard3', 'shard4', 'shard5', 'shard6']
      )
    })

    it('should handle 2 clients with 3 shards', function () {
      const shards = [
        { shard: 'shard0' },
        { shard: 'shard1' },
        { shard: 'shard2' }
      ]

      // Client 0 gets shards 0, 2 (indices 0, 2)
      // Client 1 gets shard 1 (index 1)
      const client0 = manager._partitionShards(shards, 2, 0)
      const client1 = manager._partitionShards(shards, 2, 1)

      assert.strictEqual(client0.length, 2)
      assert.strictEqual(client1.length, 1)

      assert.strictEqual(client0[0].shard, 'shard0')
      assert.strictEqual(client0[1].shard, 'shard2')
      assert.strictEqual(client1[0].shard, 'shard1')
    })
  })

  describe('_hasSortRequirement()', function () {
    let manager

    before(function () {
      manager = new DistributedQueryManager('http://localhost:8983/solr')
    })

    after(function () {
      manager.destroy()
    })

    it('should return false when no sort specified', function () {
      assert.strictEqual(manager._hasSortRequirement(null, 'id'), false)
      assert.strictEqual(manager._hasSortRequirement(undefined, 'id'), false)
      assert.strictEqual(manager._hasSortRequirement('', 'id'), false)
    })

    it('should return false when sorting by unique key only', function () {
      // Default unique key "id"
      assert.strictEqual(manager._hasSortRequirement('id', 'id'), false)
      assert.strictEqual(manager._hasSortRequirement('id asc', 'id'), false)
      assert.strictEqual(manager._hasSortRequirement('id desc', 'id'), false)
      assert.strictEqual(manager._hasSortRequirement('ID ASC', 'id'), false)
      assert.strictEqual(manager._hasSortRequirement('  id  asc  ', 'id'), false)
    })

    it('should return false when sorting by collection-specific unique key', function () {
      // genome_feature uses feature_id
      assert.strictEqual(manager._hasSortRequirement('feature_id', 'feature_id'), false)
      assert.strictEqual(manager._hasSortRequirement('feature_id asc', 'feature_id'), false)
      assert.strictEqual(manager._hasSortRequirement('feature_id desc', 'feature_id'), false)
      assert.strictEqual(manager._hasSortRequirement('FEATURE_ID ASC', 'feature_id'), false)
    })

    it('should return true when sorting by non-unique field', function () {
      assert.strictEqual(manager._hasSortRequirement('patric_id asc', 'feature_id'), true)
      assert.strictEqual(manager._hasSortRequirement('genome_id asc', 'id'), true)
      assert.strictEqual(manager._hasSortRequirement('start asc', 'feature_id'), true)
    })

    it('should return true for multi-field sort even if unique key included', function () {
      // Multi-field sorts require merge-sort to maintain global order
      assert.strictEqual(manager._hasSortRequirement('genome_id asc, feature_id asc', 'feature_id'), true)
      assert.strictEqual(manager._hasSortRequirement('patric_id asc, id asc', 'id'), true)
    })

    it('should handle missing uniqueKey by defaulting to id', function () {
      assert.strictEqual(manager._hasSortRequirement('id asc', null), false)
      assert.strictEqual(manager._hasSortRequirement('id asc', undefined), false)
      assert.strictEqual(manager._hasSortRequirement('other asc', null), true)
    })
  })

  describe('_createEmptyQueryResult()', function () {
    let manager

    before(function () {
      manager = new DistributedQueryManager('http://localhost:8983/solr')
    })

    after(function () {
      manager.destroy()
    })

    it('should create result with empty stream', function (done) {
      const result = manager._createEmptyQueryResult(1, {
        collection: 'test',
        limit: 100,
        clientCount: 4,
        clientIndex: 3
      })

      assert.strictEqual(result.queryId, 1)
      assert.strictEqual(result.metadata.collection, 'test')
      assert.strictEqual(result.metadata.shardCount, 0)
      assert.strictEqual(result.metadata.streamType, 'empty')
      assert.strictEqual(result.metadata.limit, 100)
      assert.strictEqual(result.metadata.clientCount, 4)
      assert.strictEqual(result.metadata.clientIndex, 3)

      // Verify stream ends immediately
      const docs = []
      result.stream.on('data', (doc) => docs.push(doc))
      result.stream.on('end', () => {
        assert.strictEqual(docs.length, 0)
        done()
      })
    })

    it('should have cancel function that returns false', function () {
      const result = manager._createEmptyQueryResult(1, { collection: 'test' })
      assert.strictEqual(result.cancel(), false)
    })

    it('should have getStats function', function () {
      const result = manager._createEmptyQueryResult(1, { collection: 'test' })
      const stats = result.getStats()
      assert.strictEqual(stats.queryId, 1)
      assert.strictEqual(stats.shardCount, 0)
    })
  })
})
