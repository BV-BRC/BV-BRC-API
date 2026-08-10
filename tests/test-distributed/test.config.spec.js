/**
 * Unit tests for DistributedQueryConfig
 */

const assert = require('chai').assert
const {
  getConfig,
  getDefaults,
  updateConfig,
  resetConfig,
  isAdminUser,
  getAdminUsers
} = require('../../lib/distributed/DistributedQueryConfig')

describe('DistributedQueryConfig', function () {
  // Reset config before each test
  beforeEach(function () {
    resetConfig()
  })

  describe('getDefaults()', function () {
    it('should return default configuration', function () {
      const defaults = getDefaults()

      assert.isObject(defaults)
      // Check integration settings
      assert.isBoolean(defaults.enabled)
      assert.isNumber(defaults.minLimitThreshold)
      assert.isArray(defaults.enabledCollections)
      assert.isArray(defaults.disabledCollections)
      assert.isBoolean(defaults.exposeMetadataHeaders)
      // Check core numeric defaults
      assert.isNumber(defaults.maxParallelism)
      assert.isAtLeast(defaults.maxParallelism, 1)
      assert.isAtMost(defaults.maxParallelism, 100)
      assert.isNumber(defaults.maxRetries)
      assert.isNumber(defaults.initialRetryDelayMs)
      assert.isNumber(defaults.schemaCacheTTLMinutes)
      assert.isNumber(defaults.clusterStatusCacheTTLSeconds)
      assert.isNumber(defaults.maxMergeSortHeapDocs)
      assert.isNumber(defaults.maxMemoryMB)
      assert.isNumber(defaults.cursorBatchSize)
      assert.isNumber(defaults.initialBatchSize)
      // Check prewarm defaults
      assert.isBoolean(defaults.prewarmShards)
      assert.isNumber(defaults.prewarmTimeoutMs)
      assert.isNumber(defaults.prewarmMaxConcurrent)
      // Check SSL defaults
      assert.isBoolean(defaults.rejectUnauthorized)
      // Check arrays
      assert.isArray(defaults.excludeNodes)
      assert.isArray(defaults.adminUsers)
    })
  })

  describe('getConfig()', function () {
    it('should return current configuration', function () {
      const config = getConfig()

      assert.isObject(config)
      assert.hasAllKeys(config, [
        // Integration settings
        'enabled',
        'minLimitThreshold',
        'enabledCollections',
        'disabledCollections',
        'exposeMetadataHeaders',
        // Core settings
        'maxParallelism',
        'maxRetries',
        'initialRetryDelayMs',
        'schemaCacheTTLMinutes',
        'clusterStatusCacheTTLSeconds',
        'maxMergeSortHeapDocs',
        'maxMemoryMB',
        'cursorBatchSize',
        'initialBatchSize',
        'prewarmShards',
        'prewarmTimeoutMs',
        'prewarmMaxConcurrent',
        'excludeNodes',
        'adminUsers',
        'rejectUnauthorized',
        'ca',
        // Sequence join settings
        'sequenceJoinBatchSize',
        'sequenceJoinPrefetchBatches',
        // Genome metadata cache settings
        'genomeMetadataCacheSize',
        'genomeMetadataBatchSize'
      ])
    })

    it('should return a copy, not the original', function () {
      const config1 = getConfig()
      config1.maxParallelism = 999

      const config2 = getConfig()
      assert.notEqual(config2.maxParallelism, 999)
    })
  })

  describe('updateConfig()', function () {
    it('should update single value', function () {
      updateConfig({ maxParallelism: 16 })

      const config = getConfig()
      assert.equal(config.maxParallelism, 16)
    })

    it('should update multiple values', function () {
      updateConfig({
        maxParallelism: 4,
        maxRetries: 5,
        cursorBatchSize: 5000
      })

      const config = getConfig()
      assert.equal(config.maxParallelism, 4)
      assert.equal(config.maxRetries, 5)
      assert.equal(config.cursorBatchSize, 5000)
    })

    it('should not modify other values', function () {
      const originalConfig = getConfig()
      updateConfig({ maxParallelism: 20 })

      const newConfig = getConfig()
      assert.equal(newConfig.maxParallelism, 20)
      assert.equal(newConfig.maxRetries, originalConfig.maxRetries)
      assert.equal(newConfig.cursorBatchSize, originalConfig.cursorBatchSize)
    })

    it('should ignore unknown keys', function () {
      updateConfig({ unknownKey: 'value', maxParallelism: 10 })

      const config = getConfig()
      assert.equal(config.maxParallelism, 10)
      assert.notProperty(config, 'unknownKey')
    })

    it('should validate maxParallelism bounds', function () {
      // Too low
      assert.throws(() => updateConfig({ maxParallelism: 0 }))

      // Too high (> 100)
      assert.throws(() => updateConfig({ maxParallelism: 101 }))

      // Valid at boundaries
      updateConfig({ maxParallelism: 1 })
      assert.equal(getConfig().maxParallelism, 1)

      updateConfig({ maxParallelism: 100 })
      assert.equal(getConfig().maxParallelism, 100)
    })

    it('should validate maxRetries bounds', function () {
      assert.throws(() => updateConfig({ maxRetries: -1 }))
      assert.throws(() => updateConfig({ maxRetries: 20 }))

      updateConfig({ maxRetries: 5 })
      assert.equal(getConfig().maxRetries, 5)
    })

    it('should validate cursorBatchSize bounds', function () {
      assert.throws(() => updateConfig({ cursorBatchSize: 50 }))
      assert.throws(() => updateConfig({ cursorBatchSize: 50000 }))

      updateConfig({ cursorBatchSize: 5000 })
      assert.equal(getConfig().cursorBatchSize, 5000)
    })

    it('should validate maxMergeSortHeapDocs bounds', function () {
      // Too low (< 100)
      assert.throws(() => updateConfig({ maxMergeSortHeapDocs: 99 }))

      // Too high (> 100000)
      assert.throws(() => updateConfig({ maxMergeSortHeapDocs: 100001 }))

      // Valid
      updateConfig({ maxMergeSortHeapDocs: 50000 })
      assert.equal(getConfig().maxMergeSortHeapDocs, 50000)
    })

    it('should return the updated config', function () {
      const result = updateConfig({ maxParallelism: 12 })

      assert.isObject(result)
      assert.equal(result.maxParallelism, 12)
    })
  })

  describe('resetConfig()', function () {
    it('should reset to defaults', function () {
      updateConfig({
        maxParallelism: 20,
        maxRetries: 10,
        cursorBatchSize: 8000
      })

      resetConfig()

      const config = getConfig()
      const defaults = getDefaults()

      assert.deepEqual(config, defaults)
    })

    it('should return the reset config', function () {
      updateConfig({ maxParallelism: 20 })
      const result = resetConfig()

      assert.equal(result.maxParallelism, getDefaults().maxParallelism)
    })
  })

  describe('isAdminUser()', function () {
    it('should return false for null/undefined', function () {
      assert.isFalse(isAdminUser(null))
      assert.isFalse(isAdminUser(undefined))
      assert.isFalse(isAdminUser(''))
    })

    it('should return false when no admins configured', function () {
      updateConfig({ adminUsers: [] })
      assert.isFalse(isAdminUser('someuser'))
    })

    it('should return true for configured admin', function () {
      updateConfig({ adminUsers: ['admin1', 'admin2'] })

      assert.isTrue(isAdminUser('admin1'))
      assert.isTrue(isAdminUser('admin2'))
      assert.isFalse(isAdminUser('regularuser'))
    })
  })

  describe('getAdminUsers()', function () {
    it('should return copy of admin users', function () {
      updateConfig({ adminUsers: ['admin1', 'admin2'] })

      const admins = getAdminUsers()
      assert.deepEqual(admins, ['admin1', 'admin2'])

      // Modifying returned array shouldn't affect config
      admins.push('hacker')
      assert.deepEqual(getAdminUsers(), ['admin1', 'admin2'])
    })
  })

  describe('excludeNodes', function () {
    it('should accept array of node patterns', function () {
      updateConfig({ excludeNodes: ['node1.example.com', 'node2.*'] })

      const config = getConfig()
      assert.deepEqual(config.excludeNodes, ['node1.example.com', 'node2.*'])
    })
  })
})
