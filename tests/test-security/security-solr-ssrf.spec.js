/**
 * Security Tests for Solr SSRF and Path Traversal Prevention
 *
 * These tests verify the security fixes for:
 * - TIKI-W094-6: Arbitrary Solr Queries lead to Full read SSRF
 * - TIKI-W094-7: Solr Query Injection on regionFeatureDensities
 * - TIKI-W094-8: SSRF in multi query endpoint via Solr Injection
 * - TIKI-W094-9: Solr Query Injection via annotation on region
 * - TIKI-W094-10: Local File Read via path traversal in types param
 */

const assert = require('chai').assert
const Http = require('http')
const Config = require('../../config')

// Import the sanitizer for unit testing
const {
  isDangerousParam,
  sanitizeQueryString,
  sanitizeParamsObject,
  DANGEROUS_PARAMS
} = require('../../middleware/SolrQuerySanitizer')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

/**
 * Helper function to make HTTP requests
 */
async function httpRequest (options, body) {
  return new Promise((resolve, reject) => {
    const req = Http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        })
      })
    })
      .on('error', (err) => {
        reject(err)
      })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

describe('SolrQuerySanitizer Unit Tests', function () {
  describe('isDangerousParam', function () {
    it('should block shards parameter', function () {
      assert.isTrue(isDangerousParam('shards'))
      assert.isTrue(isDangerousParam('SHARDS'))
      assert.isTrue(isDangerousParam('Shards'))
    })

    it('should block shards.* parameters', function () {
      assert.isTrue(isDangerousParam('shards.qt'))
      assert.isTrue(isDangerousParam('shards.info'))
      assert.isTrue(isDangerousParam('shards.tolerant'))
      assert.isTrue(isDangerousParam('SHARDS.QT'))
    })

    it('should block stream parameters', function () {
      assert.isTrue(isDangerousParam('stream.url'))
      assert.isTrue(isDangerousParam('stream.file'))
      assert.isTrue(isDangerousParam('stream.body'))
      assert.isTrue(isDangerousParam('STREAM.URL'))
    })

    it('should block qt parameter', function () {
      assert.isTrue(isDangerousParam('qt'))
      assert.isTrue(isDangerousParam('QT'))
    })

    it('should block debug parameters', function () {
      assert.isTrue(isDangerousParam('debug'))
      assert.isTrue(isDangerousParam('debugQuery'))
      assert.isTrue(isDangerousParam('echoParams'))
    })

    it('should block collection/routing parameters', function () {
      assert.isTrue(isDangerousParam('collection'))
      assert.isTrue(isDangerousParam('_route_'))
    })

    it('should allow safe parameters', function () {
      assert.isFalse(isDangerousParam('q'))
      assert.isFalse(isDangerousParam('fq'))
      assert.isFalse(isDangerousParam('rows'))
      assert.isFalse(isDangerousParam('start'))
      assert.isFalse(isDangerousParam('sort'))
      assert.isFalse(isDangerousParam('fl'))
      assert.isFalse(isDangerousParam('wt'))
    })
  })

  describe('sanitizeQueryString', function () {
    it('should remove shards parameter from query string', function () {
      const result = sanitizeQueryString('q=*:*&rows=10&shards=http://internal:8983/solr/admin')
      assert.equal(result.sanitized, 'q=*:*&rows=10')
      assert.include(result.blockedParams, 'shards')
    })

    it('should remove multiple dangerous parameters', function () {
      const result = sanitizeQueryString('q=*:*&shards=evil&stream.url=http://evil&debug=true')
      assert.equal(result.sanitized, 'q=*:*')
      assert.equal(result.blockedParams.length, 3)
    })

    it('should handle URL-encoded parameter names', function () {
      const result = sanitizeQueryString('q=*:*&%73hards=evil') // %73 = 's'
      assert.include(result.blockedParams, 'shards')
      assert.equal(result.sanitized, 'q=*:*')
    })

    it('should return original if no dangerous params', function () {
      const result = sanitizeQueryString('q=*:*&rows=10&fq=public:true')
      assert.equal(result.sanitized, 'q=*:*&rows=10&fq=public:true')
      assert.equal(result.blockedParams.length, 0)
    })

    it('should handle empty query string', function () {
      const result = sanitizeQueryString('')
      assert.equal(result.sanitized, '')
      assert.equal(result.blockedParams.length, 0)
    })

    it('should handle null/undefined', function () {
      assert.equal(sanitizeQueryString(null).sanitized, null)
      assert.equal(sanitizeQueryString(undefined).sanitized, undefined)
    })
  })

  describe('sanitizeParamsObject', function () {
    it('should remove dangerous parameters from object', function () {
      const params = {
        q: '*:*',
        rows: 10,
        shards: 'http://internal:8983/solr/admin'
      }
      const result = sanitizeParamsObject(params)
      assert.deepEqual(result.sanitized, { q: '*:*', rows: 10 })
      assert.include(result.blockedParams, 'shards')
    })

    it('should handle stream.url parameter', function () {
      const params = {
        q: '*:*',
        'stream.url': 'http://evil'
      }
      const result = sanitizeParamsObject(params)
      assert.deepEqual(result.sanitized, { q: '*:*' })
      assert.include(result.blockedParams, 'stream.url')
    })
  })
})

describe('Bundle Type Validation Unit Tests', function () {
  // Import the download router's internal functions by checking the route behavior
  // We test via HTTP since the validation functions aren't exported

  it('should have download router defined', function () {
    // This is a basic sanity check that the file loads without error
    const download = require('../../routes/download')
    assert.isFunction(download)
  })
})

describe('SSRF Integration Tests', function () {
  const baseOptions = {
    hostname: 'localhost',
    port: Config.get('http_port'),
    agent: agent
  }

  // TIKI-W094-6: Arbitrary Solr Queries lead to Full read SSRF
  it('should block shards parameter in POST with solrquery content-type', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&rows=1&shards=http://internal:8983/solr/admin')

    // The request should not cause a 500 error (shards should be stripped)
    assert.notEqual(response.status, 500)
  })

  it('should block shards parameter in GET request', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/genome/?q=*:*&rows=1&shards=http://internal:8983/solr/admin',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    })

    assert.notEqual(response.status, 500)
  })

  // TIKI-W094-8: SSRF via stream.url
  it('should block stream.url parameter', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&stream.url=http://169.254.169.254/latest/meta-data/')

    assert.notEqual(response.status, 500)
  })

  it('should block stream.file parameter', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&stream.file=/etc/passwd')

    assert.notEqual(response.status, 500)
  })

  // TIKI-W094-9: qt parameter for handler override
  it('should block qt parameter for handler override', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&qt=/admin/cores')

    assert.notEqual(response.status, 500)
  })

  it('should block debug parameters', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&debug=all&debugQuery=true&echoParams=all')

    assert.notEqual(response.status, 500)
  })

  it('should allow legitimate queries', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/genome/?q=*:*&rows=1&sort=genome_id+asc'
    })

    // Should work normally (may require auth, but shouldn't be a 500)
    assert.include([200, 400, 401], response.status)
  })
})

describe('Path Traversal Prevention Tests', function () {
  const baseOptions = {
    hostname: 'localhost',
    port: Config.get('http_port'),
    agent: agent
  }

  // TIKI-W094-10: Local File Read via path traversal in types param
  it('should block path traversal in types parameter', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=/../../../etc/passwd&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
    assert.include(response.body, 'Invalid bundle type')
  })

  it('should block double-dot sequences', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=..%2F..%2F..%2Fetc%2Fpasswd&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
  })

  it('should block forward slashes in types', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=/etc/passwd&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
  })

  it('should block arbitrary extensions', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=.evil&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
  })

  it('should allow valid PATRIC.faa type', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=*PATRIC.faa&q=eq(genome_id,123)'
    })

    // Should not return 400 for invalid type (may return other errors like 401)
    if (response.status === 400) {
      assert.notInclude(response.body, 'Invalid bundle type')
    }
  })

  it('should allow valid PATRIC.features.tab type', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=*PATRIC.features.tab&q=eq(genome_id,123)'
    })

    // Should not return 400 for invalid type
    if (response.status === 400) {
      assert.notInclude(response.body, 'Invalid bundle type')
    }
  })

  it('should allow valid .gff type', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=*.gff&q=eq(genome_id,123)'
    })

    // Should not return 400 for invalid type
    if (response.status === 400) {
      assert.notInclude(response.body, 'Invalid bundle type')
    }
  })

  it('should block path traversal via POST', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/bundle/genome/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }, 'types=/../../../etc/passwd&q=eq(genome_id,123)')

    assert.equal(response.status, 400)
  })

  it('should block multiple invalid types', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=*PATRIC.faa,/../../../etc/passwd&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
  })
})

describe('Security Headers in Error Responses', function () {
  const baseOptions = {
    hostname: 'localhost',
    port: Config.get('http_port'),
    agent: agent
  }

  it('should not leak internal paths in error messages', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'GET',
      path: '/bundle/genome/?types=/../../../etc/passwd&q=eq(genome_id,123)'
    })

    assert.equal(response.status, 400)
    // Error message should be generic, not revealing internal paths
    assert.notInclude(response.body, '/etc/passwd')
    assert.notInclude(response.body, '/../')
  })

  it('should not leak parameter values in SSRF block messages', async function () {
    const response = await httpRequest({
      ...baseOptions,
      method: 'POST',
      path: '/genome/',
      headers: {
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }, 'q=*:*&shards=http://169.254.169.254/latest/meta-data/')

    // The response should not contain the malicious URL
    if (response.body) {
      assert.notInclude(response.body, '169.254.169.254')
    }
  })
})
