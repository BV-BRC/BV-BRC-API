/**
 * Integration tests for JoinEnrichment middleware
 *
 * Tests middleware behavior including:
 * - Skipping non-query requests
 * - Skipping when no join fields requested
 * - Performing enrichment when join fields requested
 * - Handling multiple join fields from same collection
 * - Working with pagination
 */

const assert = require('chai').assert
const parseFieldList = require('../../lib/parseFieldList')
const { getRequestedJoinFields } = require('../../lib/parseFieldList')
const { getJoinConfig, buildJoinSpecs } = require('../../middleware/JoinEnrichment')

describe('parseFieldList', function () {
  describe('Basic Parsing', function () {
    it('should parse fl= parameter from query string', function () {
      const fields = parseFieldList('&q=*:*&fl=genome_id,genome_name,product&rows=10')

      assert.isNotNull(fields)
      assert.isTrue(fields.has('genome_id'))
      assert.isTrue(fields.has('genome_name'))
      assert.isTrue(fields.has('product'))
      assert.equal(fields.size, 3)
    })

    it('should return null when no fl= parameter', function () {
      const fields = parseFieldList('&q=*:*&rows=10')

      assert.isNull(fields)
    })

    it('should return null for fl=*', function () {
      const fields = parseFieldList('&q=*:*&fl=*&rows=10')

      assert.isNull(fields)
    })

    it('should return null for empty fl=', function () {
      const fields = parseFieldList('&q=*:*&fl=&rows=10')

      assert.isNull(fields)
    })

    it('should handle URL-encoded field names', function () {
      const fields = parseFieldList('&q=*:*&fl=genome_id%2Cgenome_name&rows=10')

      assert.isNotNull(fields)
      assert.isTrue(fields.has('genome_id'))
      assert.isTrue(fields.has('genome_name'))
    })

    it('should handle + as space in URL encoding', function () {
      const fields = parseFieldList('&q=*:*&fl=genome_id,+genome_name&rows=10')

      assert.isNotNull(fields)
      assert.isTrue(fields.has('genome_id'))
      assert.isTrue(fields.has('genome_name'))
    })

    it('should handle fl at start of query', function () {
      const fields = parseFieldList('fl=genome_id,genome_name&q=*:*')

      assert.isNotNull(fields)
      assert.isTrue(fields.has('genome_id'))
    })

    it('should handle empty input', function () {
      assert.isNull(parseFieldList(''))
      assert.isNull(parseFieldList(null))
      assert.isNull(parseFieldList(undefined))
    })
  })
})

describe('getRequestedJoinFields', function () {
  const joinableFields = {
    genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
    taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
    genome_status: { from: 'genome', via: 'genome_id', field: 'genome_status' },
    strain: { from: 'genome', via: 'genome_id', field: 'strain' }
  }

  it('should return requested join fields', function () {
    const query = '&q=*:*&fl=patric_id,genome_name,product&rows=10'
    const requested = getRequestedJoinFields(query, joinableFields)

    assert.deepEqual(requested, ['genome_name'])
  })

  it('should return multiple join fields when requested', function () {
    const query = '&q=*:*&fl=patric_id,genome_name,taxon_id,product&rows=10'
    const requested = getRequestedJoinFields(query, joinableFields)

    assert.includeMembers(requested, ['genome_name', 'taxon_id'])
    assert.equal(requested.length, 2)
  })

  it('should return empty array when no join fields requested', function () {
    const query = '&q=*:*&fl=patric_id,product,aa_length&rows=10'
    const requested = getRequestedJoinFields(query, joinableFields)

    assert.deepEqual(requested, [])
  })

  it('should return empty array when no fl= specified (all fields)', function () {
    const query = '&q=*:*&rows=10'
    const requested = getRequestedJoinFields(query, joinableFields)

    assert.deepEqual(requested, [])
  })

  it('should handle empty joinableFields', function () {
    const query = '&q=*:*&fl=genome_name&rows=10'
    const requested = getRequestedJoinFields(query, {})

    assert.deepEqual(requested, [])
  })

  it('should handle null joinableFields', function () {
    const query = '&q=*:*&fl=genome_name&rows=10'
    const requested = getRequestedJoinFields(query, null)

    assert.deepEqual(requested, [])
  })
})

describe('getJoinConfig', function () {
  it('should return default configuration', function () {
    const config = getJoinConfig()

    assert.isTrue(config.enabled)
    assert.isNumber(config.cacheSize)
    assert.isObject(config.collections)
  })

  it('should have genome_feature collection configured', function () {
    const config = getJoinConfig()

    assert.isObject(config.collections.genome_feature)
    assert.isObject(config.collections.genome_feature.joinableFields)
    assert.isObject(config.collections.genome_feature.joinableFields.genome_name)
  })

  it('should have pathway collection configured', function () {
    const config = getJoinConfig()

    assert.isObject(config.collections.pathway)
    assert.isObject(config.collections.pathway.joinableFields)
  })
})

describe('buildJoinSpecs', function () {
  const joinableFields = {
    genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
    taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
    genome_status: { from: 'genome', via: 'genome_id', field: 'genome_status' },
    strain: { from: 'genome', via: 'genome_id', field: 'strain' }
  }

  it('should build single join spec for one field', function () {
    const specs = buildJoinSpecs(['genome_name'], joinableFields)

    assert.equal(specs.length, 1)
    assert.equal(specs[0].targetCollection, 'genome')
    assert.equal(specs[0].localField, 'genome_id')
    assert.equal(specs[0].foreignField, 'genome_id')
    assert.deepEqual(specs[0].fields, ['genome_name'])
  })

  it('should group multiple fields from same collection', function () {
    const specs = buildJoinSpecs(['genome_name', 'taxon_id', 'strain'], joinableFields)

    // All fields are from 'genome' via 'genome_id', so should be one spec
    assert.equal(specs.length, 1)
    assert.equal(specs[0].targetCollection, 'genome')
    assert.includeMembers(specs[0].fields, ['genome_name', 'taxon_id', 'strain'])
  })

  it('should return empty array for no fields', function () {
    const specs = buildJoinSpecs([], joinableFields)

    assert.deepEqual(specs, [])
  })

  it('should handle unknown fields gracefully', function () {
    const specs = buildJoinSpecs(['unknown_field'], joinableFields)

    assert.deepEqual(specs, [])
  })

  it('should handle mixed known/unknown fields', function () {
    const specs = buildJoinSpecs(['genome_name', 'unknown_field'], joinableFields)

    assert.equal(specs.length, 1)
    assert.deepEqual(specs[0].fields, ['genome_name'])
  })
})

describe('JoinEnrichment Middleware', function () {
  // Mock request/response objects for middleware testing

  describe('Request Filtering', function () {
    it('should skip non-query methods', function (done) {
      // This tests the middleware's decision logic
      // The middleware checks req.call_method !== 'query'
      const mockReq = {
        call_method: 'get',
        call_collection: 'genome_feature',
        call_params: ['&q=*:*&fl=genome_name&rows=10']
      }

      const mockRes = {
        results: {
          response: {
            docs: [{ genome_id: 'genome1' }]
          }
        },
        set: () => {}
      }

      // Import middleware
      const joinEnrichment = require('../../middleware/JoinEnrichment')

      // Call middleware
      joinEnrichment(mockReq, mockRes, (err) => {
        assert.isUndefined(err)
        // Should pass through without enrichment
        assert.isUndefined(mockRes.results.response.docs[0].genome_name)
        done()
      })
    })

    it('should skip when no response docs', function (done) {
      const mockReq = {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['&q=*:*&fl=genome_name&rows=10']
      }

      const mockRes = {
        results: {
          response: {
            docs: [] // Empty docs
          }
        },
        set: () => {}
      }

      const joinEnrichment = require('../../middleware/JoinEnrichment')

      joinEnrichment(mockReq, mockRes, (err) => {
        assert.isUndefined(err)
        done()
      })
    })

    it('should skip when no results object', function (done) {
      const mockReq = {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['&q=*:*&fl=genome_name&rows=10']
      }

      const mockRes = {
        results: null,
        set: () => {}
      }

      const joinEnrichment = require('../../middleware/JoinEnrichment')

      joinEnrichment(mockReq, mockRes, (err) => {
        assert.isUndefined(err)
        done()
      })
    })

    it('should skip unconfigured collections', function (done) {
      const mockReq = {
        call_method: 'query',
        call_collection: 'some_unknown_collection',
        call_params: ['&q=*:*&fl=genome_name&rows=10']
      }

      const mockRes = {
        results: {
          response: {
            docs: [{ genome_id: 'genome1' }]
          }
        },
        set: () => {}
      }

      const joinEnrichment = require('../../middleware/JoinEnrichment')

      joinEnrichment(mockReq, mockRes, (err) => {
        assert.isUndefined(err)
        // Should pass through without enrichment attempt
        done()
      })
    })

    it('should skip when no join fields in select', function (done) {
      const mockReq = {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['&q=*:*&fl=patric_id,product,aa_length&rows=10']
      }

      const mockRes = {
        results: {
          response: {
            docs: [{ genome_id: 'genome1', patric_id: 'p1' }]
          }
        },
        set: () => {}
      }

      const joinEnrichment = require('../../middleware/JoinEnrichment')

      joinEnrichment(mockReq, mockRes, (err) => {
        assert.isUndefined(err)
        // genome_name should not be added
        assert.isUndefined(mockRes.results.response.docs[0].genome_name)
        done()
      })
    })
  })

  describe('Field List Detection', function () {
    it('should detect genome_name as joinable for genome_feature', function () {
      const config = getJoinConfig()
      const joinableFields = config.collections.genome_feature.joinableFields

      const query = '&q=*:*&fl=patric_id,genome_name,product&rows=10'
      const requested = getRequestedJoinFields(query, joinableFields)

      assert.includeMembers(requested, ['genome_name'])
    })

    it('should detect multiple joinable fields', function () {
      const config = getJoinConfig()
      const joinableFields = config.collections.genome_feature.joinableFields

      const query = '&q=*:*&fl=patric_id,genome_name,taxon_id,genome_status,product&rows=10'
      const requested = getRequestedJoinFields(query, joinableFields)

      assert.includeMembers(requested, ['genome_name', 'taxon_id', 'genome_status'])
    })

    it('should not join when fl=* (all fields)', function () {
      const config = getJoinConfig()
      const joinableFields = config.collections.genome_feature.joinableFields

      const query = '&q=*:*&fl=*&rows=10'
      const requested = getRequestedJoinFields(query, joinableFields)

      assert.deepEqual(requested, [])
    })

    it('should not join when no fl= specified', function () {
      const config = getJoinConfig()
      const joinableFields = config.collections.genome_feature.joinableFields

      const query = '&q=*:*&rows=10'
      const requested = getRequestedJoinFields(query, joinableFields)

      assert.deepEqual(requested, [])
    })
  })
})
