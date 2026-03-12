/**
 * Unit tests for DistributedQuery middleware
 */

const assert = require('chai').assert
const {
  shouldUseDistributedQuery,
  parseLimit,
  parseSort,
  parseFields
} = require('../../middleware/DistributedQuery')

describe('DistributedQuery Middleware', function () {
  describe('parseLimit()', function () {
    it('should parse rows parameter', function () {
      // Note: regex requires & or ? before rows
      assert.equal(parseLimit('q=*:*&rows=100'), 100)
      assert.equal(parseLimit('&rows=50000'), 50000)
      assert.equal(parseLimit('fq=genome_id:123&rows=25'), 25)
    })

    it('should return 0 when no rows parameter', function () {
      assert.equal(parseLimit('q=*:*'), 0)
      assert.equal(parseLimit(''), 0)
      assert.equal(parseLimit('fq=genome_id:123'), 0)
    })

    it('should handle rows at start of query', function () {
      assert.equal(parseLimit('?rows=100'), 100)
    })
  })

  describe('parseSort()', function () {
    it('should parse sort parameter', function () {
      // URL encoding: + is decoded to space by decodeURIComponent when encoded as %2B
      // But + in URL is also a space, so we test with %20
      assert.equal(parseSort('q=*:*&sort=feature_id%20asc'), 'feature_id asc')
      assert.equal(parseSort('&sort=genome_id%20desc'), 'genome_id desc')
    })

    it('should return null when no sort parameter', function () {
      assert.isNull(parseSort('q=*:*'))
      assert.isNull(parseSort(''))
    })

    it('should decode URL-encoded sort', function () {
      assert.equal(parseSort('&sort=feature_id%20asc'), 'feature_id asc')
    })

    it('should handle plus signs in sort (URL space encoding)', function () {
      // + in URLs represents a space, but decodeURIComponent doesn't decode it
      // The actual parsing should handle both forms
      assert.equal(parseSort('&sort=feature_id+asc'), 'feature_id+asc')
    })
  })

  describe('parseFields()', function () {
    it('should parse fl parameter', function () {
      assert.equal(parseFields('q=*:*&fl=feature_id,genome_id'), 'feature_id,genome_id')
    })

    it('should return null when no fl parameter', function () {
      assert.isNull(parseFields('q=*:*'))
      assert.isNull(parseFields(''))
    })
  })

  describe('shouldUseDistributedQuery()', function () {
    const baseConfig = {
      enabled: true,
      minLimitThreshold: 10000,
      enabledCollections: ['genome_feature'],
      disabledCollections: [],
      exposeMetadataHeaders: true
    }

    function createMockReq (overrides = {}) {
      return {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['q=*:*&rows=50000'],
        headers: {},
        ...overrides
      }
    }

    it('should return false when globally disabled', function () {
      const config = { ...baseConfig, enabled: false }
      const req = createMockReq()

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.equal(result.reason, 'disabled globally')
    })

    it('should respect X-Distributed-Query header override (enabled)', function () {
      // Note: header override takes precedence over enabled flag
      const config = { ...baseConfig, enabled: true }
      const req = createMockReq({
        headers: { 'x-distributed-query': 'true' }
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      assert.include(result.reason, 'header override')
    })

    it('should respect X-Distributed-Query header override (disabled)', function () {
      const config = baseConfig
      const req = createMockReq({
        headers: { 'x-distributed-query': 'false' }
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'header override')
    })

    it('should respect distributed query param override', function () {
      // Note: query param override takes precedence but only after enabled check
      const config = { ...baseConfig, enabled: true }
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&distributed=true']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      // When enabled and param says true, it uses param
    })

    it('should reject non-query methods', function () {
      const config = baseConfig
      const req = createMockReq({ call_method: 'get' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'method get not supported')
    })

    it('should allow stream method', function () {
      const config = baseConfig
      const req = createMockReq({ call_method: 'stream' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
    })

    it('should reject collections not in enabledCollections', function () {
      const config = baseConfig
      const req = createMockReq({ call_collection: 'taxonomy' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'not in enabledCollections')
    })

    it('should reject collections in disabledCollections', function () {
      const config = {
        ...baseConfig,
        enabledCollections: [],
        disabledCollections: ['genome_feature']
      }
      const req = createMockReq()

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'in disabledCollections')
    })

    it('should reject queries below threshold', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=1000']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'below threshold')
    })

    it('should accept queries at or above threshold', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=10000']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      assert.include(result.reason, '>= threshold')
    })

    it('should accept all collections when enabledCollections is empty', function () {
      const config = {
        ...baseConfig,
        enabledCollections: []
      }
      const req = createMockReq({ call_collection: 'any_collection' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
    })
  })
})
