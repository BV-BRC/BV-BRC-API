/**
 * lib/internalQuery — query construction, permission scoping, and the collection guard.
 *
 * Runs offline. Solrjs.prototype.query is stubbed to capture the query string the module
 * would have sent, so these assert on *what gets sent to Solr* rather than on what Solr
 * returns. That is the right level: the failure mode this module could introduce is a
 * missing or wrong permission filter, which a mock returning canned docs would hide
 * completely.
 *
 * The permission cases mirror tests/test-permissions/test.permissionfilter.spec.js, but
 * exercise them through internalQuery so a regression in the wiring — not just in
 * buildPermissionFq — is caught.
 */
const assert = require('chai').assert
const Solrjs = require('../../lib/solrjs')
const internalQuery = require('../../lib/internalQuery')
const { internalQueryDocs } = require('../../lib/internalQuery')

describe('lib/internalQuery', function () {
  let sent
  let stubResponse
  let originalQuery

  before(function () {
    originalQuery = Solrjs.prototype.query
  })

  after(function () {
    Solrjs.prototype.query = originalQuery
  })

  beforeEach(function () {
    sent = []
    stubResponse = { response: { docs: [], numFound: 0 } }
    Solrjs.prototype.query = function (q) {
      sent.push({ query: q, url: this.url, timeout: this.timeout, headers: this.customHeaders })
      return Promise.resolve(stubResponse)
    }
  })

  describe('collection guard', function () {
    // The HTTP path gates this at app.js:187 via app.param('dataType'). Bypassing HTTP
    // bypasses that gate, and multiQuery builds the target from client-supplied input.
    it('rejects a collection that is not configured', async function () {
      try {
        await internalQuery({ collection: 'not_a_real_core', query: 'eq(a,b)' })
        assert.fail('should have rejected')
      } catch (err) {
        assert.include(err.message, 'Unknown collection')
        assert.equal(err.statusCode, 404)
      }
      assert.lengthOf(sent, 0, 'must not reach Solr')
    })

    it('rejects a missing collection', async function () {
      try {
        await internalQuery({ query: 'eq(a,b)' })
        assert.fail('should have rejected')
      } catch (err) {
        assert.include(err.message, 'Unknown collection')
      }
    })

    it('accepts a configured collection', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(genome_id,83332.12)' })
      assert.lengthOf(sent, 1)
      assert.include(sent[0].url, '/genome')
    })
  })

  describe('permission scoping', function () {
    it('anonymous on a non-publicFree collection gets public:true', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(genome_id,83332.12)' })
      assert.include(sent[0].query, '&fq=public:true')
    })

    it('an authenticated user gets the owner/user_read triple', async function () {
      await internalQuery({
        collection: 'genome',
        query: 'eq(genome_id,83332.12)',
        user: 'olson@patricbrc.org'
      })
      const q = sent[0].query
      assert.include(q, 'public:true')
      assert.include(q, 'owner:olson@patricbrc.org')
      assert.include(q, 'user_read:olson@patricbrc.org')
    })

    it('applies no filter to a publicFree collection', async function () {
      // taxonomy is in the publicFree list, so buildPermissionFq returns null.
      await internalQuery({ collection: 'taxonomy', query: 'eq(taxon_id,1386)' })
      assert.notInclude(sent[0].query, 'fq=public:true')
      assert.notInclude(sent[0].query, 'owner:')
    })

    it('defaults publicFree from PublicDataTypes rather than failing closed', async function () {
      // buildPermissionFq requires an array and fails CLOSED without one, which would
      // wrongly filter an exempt collection. The default must prevent that.
      await internalQuery({ collection: 'taxonomy', query: 'eq(taxon_id,1386)' })
      assert.notInclude(sent[0].query, 'public:true',
        'exempt collection must not be filtered when publicFree is defaulted')
    })

    it('honors an explicit publicFree override', async function () {
      // genome is NOT normally publicFree; overriding proves the value is threaded
      // through rather than ignored.
      await internalQuery({
        collection: 'genome',
        query: 'eq(genome_id,83332.12)',
        publicFree: ['genome']
      })
      assert.notInclude(sent[0].query, 'public:true')
    })

    it('sets X-Authenticated-User when a user is supplied', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(a,b)', user: 'someone@bvbrc' })
      assert.equal(sent[0].headers['X-Authenticated-User'], 'someone@bvbrc')
    })

    it('sets no X-Authenticated-User when anonymous', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(a,b)' })
      assert.isTrue(!sent[0].headers || !sent[0].headers['X-Authenticated-User'])
    })
  })

  describe('query conversion', function () {
    it('converts RQL to a Solr query', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(genome_id,83332.12)' })
      const q = sent[0].query
      assert.include(q, 'genome_id')
      assert.include(q, '83332.12')
      assert.include(q, 'rows=', 'a row limit must always be applied')
    })

    it('passes a solr-type query through without RQL conversion', async function () {
      await internalQuery({
        collection: 'genome',
        query: 'q=*:*&rows=0&json.facet={x:"unique(family)"}',
        queryType: 'solr'
      })
      assert.include(sent[0].query, 'json.facet=')
      assert.include(sent[0].query, 'q=*:*')
    })

    it('still permission-scopes a solr-type query', async function () {
      // The raw-Solr path must not be an escape hatch around the permission filter.
      await internalQuery({
        collection: 'genome',
        query: 'q=*:*&rows=0',
        queryType: 'solr'
      })
      assert.include(sent[0].query, '&fq=public:true')
    })

    it('applies a default row limit to an empty query', async function () {
      await internalQuery({ collection: 'genome', query: '' })
      assert.include(sent[0].query, 'rows=')
    })
  })

  describe('timeout', function () {
    it('applies a default timeout', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(a,b)' })
      assert.equal(sent[0].timeout, 120000)
    })

    it('honors a per-call timeout', async function () {
      await internalQuery({ collection: 'genome', query: 'eq(a,b)', timeout: 5000 })
      assert.equal(sent[0].timeout, 5000)
    })
  })

  describe('error handling', function () {
    it('throws on a Solr error body returned with HTTP 200', async function () {
      // Solr reports query errors in the body, not the status, so this must be
      // detected explicitly or it becomes another silent-200.
      stubResponse = { error: { code: 400, msg: 'undefined field bogus' } }
      try {
        await internalQuery({ collection: 'genome', query: 'eq(bogus,1)' })
        assert.fail('should have thrown')
      } catch (err) {
        assert.include(err.message, 'undefined field bogus')
        assert.equal(err.statusCode, 400)
      }
    })
  })

  describe('internalQueryDocs', function () {
    it('returns the docs array', async function () {
      stubResponse = { response: { docs: [{ genome_id: '83332.12' }], numFound: 1 } }
      const docs = await internalQueryDocs({ collection: 'genome', query: 'eq(a,b)' })
      assert.isArray(docs)
      assert.lengthOf(docs, 1)
      assert.equal(docs[0].genome_id, '83332.12')
    })

    it('returns [] when there is no response body', async function () {
      stubResponse = {}
      const docs = await internalQueryDocs({ collection: 'genome', query: 'eq(a,b)' })
      assert.isArray(docs)
      assert.lengthOf(docs, 0)
    })
  })
})
