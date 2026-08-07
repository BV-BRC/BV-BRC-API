/**
 * CrossCollectionSource — allowlist + source permission scoping
 *
 * Phase 1 of PLAN_CROSS_COLLECTION_DOWNLOAD.md. This middleware is a security
 * boundary: it decides whether a client may name a second collection at all, and
 * it is the ONLY place the source query gets permission-scoped (DecorateQuery
 * scopes the target and knows nothing about the source).
 */

const assert = require('chai').assert
const CrossCollectionSource = require('../../middleware/CrossCollectionSource')
const { isAllowed, DEFAULT_ALLOWED_SOURCES } = CrossCollectionSource

const publicFree = ['taxonomy', 'feature_sequence', 'protein_feature']

// Minimal Express response double capturing status()/json().
function mockRes () {
  return {
    statusCode: null,
    body: null,
    status (code) { this.statusCode = code; return this },
    json (payload) { this.body = payload; return this }
  }
}

function run (req) {
  const res = mockRes()
  let nexted = false
  CrossCollectionSource(req, res, () => { nexted = true })
  return { res, nexted }
}

describe('CrossCollectionSource', function () {
  describe('inertness (must not disturb normal requests)', function () {
    it('is a no-op when sourceParams is absent entirely', function () {
      const req = { call_collection: 'genome_feature' }
      const { nexted, res } = run(req)
      assert.isTrue(nexted)
      assert.isUndefined(req._crossSource)
      assert.isNull(res.statusCode)
    })

    it('is a no-op when no http_source_* params were sent', function () {
      const req = { call_collection: 'genome_feature', sourceParams: {} }
      const { nexted } = run(req)
      assert.isTrue(nexted)
      assert.isUndefined(req._crossSource)
    })

    it('does not care about unrelated http_source-prefixed junk being empty', function () {
      const req = { call_collection: 'genome_feature', sourceParams: { http_source_unrelated: 'x' } }
      const { nexted } = run(req)
      assert.isTrue(nexted, 'unknown source params alone should not trigger the path')
      assert.isUndefined(req._crossSource)
    })
  })

  describe('malformed requests fail loudly', function () {
    it('rejects source_collection without link_field', function () {
      const req = { call_collection: 'genome_feature', sourceParams: { http_source_collection: 'sp_gene' } }
      const { res, nexted } = run(req)
      assert.isFalse(nexted, 'must not continue the chain')
      assert.equal(res.statusCode, 400)
      assert.include(res.body.message, 'http_source_link_field')
    })

    it('rejects link_field without source_collection', function () {
      // Silently ignoring this would run the SOURCE filter against the TARGET
      // collection — wrong results, no error.
      const req = { call_collection: 'genome_feature', sourceParams: { http_source_link_field: 'feature_id' } }
      const { res, nexted } = run(req)
      assert.isFalse(nexted)
      assert.equal(res.statusCode, 400)
    })

    it('rejects when there is no target collection', function () {
      const req = { sourceParams: { http_source_collection: 'sp_gene', http_source_link_field: 'feature_id' } }
      const { res, nexted } = run(req)
      assert.isFalse(nexted)
      assert.equal(res.statusCode, 400)
    })
  })

  describe('allowlist', function () {
    it('accepts the sp_gene -> genome_feature triple', function () {
      const req = {
        call_collection: 'genome_feature',
        sourceParams: { http_source_collection: 'sp_gene', http_source_link_field: 'feature_id' },
        _rawBody: 'eq(property,Antibiotic%20Resistance)',
        publicFree
      }
      const { nexted, res } = run(req)
      assert.isTrue(nexted)
      assert.isNull(res.statusCode)
      assert.equal(req._crossSource.collection, 'sp_gene')
      assert.equal(req._crossSource.linkField, 'feature_id')
      assert.equal(req._crossSource.target, 'genome_feature')
    })

    it('accepts genome -> genome_sequence (contig case)', function () {
      const req = {
        call_collection: 'genome_sequence',
        sourceParams: { http_source_collection: 'genome', http_source_link_field: 'genome_id' },
        _rawBody: 'eq(taxon_id,1)',
        publicFree
      }
      const { nexted } = run(req)
      assert.isTrue(nexted)
      assert.equal(req._crossSource.target, 'genome_sequence')
    })

    it('rejects an arbitrary source collection', function () {
      // Without the allowlist this is a read-any-collection primitive.
      const req = {
        call_collection: 'genome_feature',
        sourceParams: { http_source_collection: 'genome_amr', http_source_link_field: 'genome_id' },
        _rawBody: '',
        publicFree
      }
      const { res, nexted } = run(req)
      assert.isFalse(nexted)
      assert.equal(res.statusCode, 400)
      assert.include(res.body.message, 'genome_amr')
    })

    it('rejects a valid source with the WRONG link field', function () {
      const req = {
        call_collection: 'genome_feature',
        sourceParams: { http_source_collection: 'sp_gene', http_source_link_field: 'owner' },
        _rawBody: '',
        publicFree
      }
      const { res, nexted } = run(req)
      assert.isFalse(nexted)
      assert.equal(res.statusCode, 400)
    })

    it('rejects a valid source+link against the WRONG target', function () {
      // sp_gene -> feature_id is allowlisted for genome_feature, not for genome.
      const req = {
        call_collection: 'genome',
        sourceParams: { http_source_collection: 'sp_gene', http_source_link_field: 'feature_id' },
        _rawBody: '',
        publicFree
      }
      const { res, nexted } = run(req)
      assert.isFalse(nexted)
      assert.equal(res.statusCode, 400)
    })

    it('does not allowlist genome_feature -> genome_feature', function () {
      // The earlier draft of the plan listed this as "degenerate; direct". It
      // does not exist client-side and must not be silently accepted.
      assert.isFalse(isAllowed(DEFAULT_ALLOWED_SOURCES, 'genome_feature', 'feature_id', 'genome_feature'))
    })
  })

  describe('source permission scoping (the IDOR guard)', function () {
    const sourceParams = { http_source_collection: 'sp_gene', http_source_link_field: 'feature_id' }

    it('scopes an anonymous source query to public rows', function () {
      const req = { call_collection: 'genome_feature', sourceParams, _rawBody: 'eq(x,1)', publicFree }
      run(req)
      assert.equal(req._crossSource.permissionFq, 'public:true')
    })

    it('scopes an authenticated source query to the user', function () {
      const req = {
        call_collection: 'genome_feature', sourceParams, _rawBody: 'eq(x,1)', publicFree, user: 'alice'
      }
      run(req)
      assert.include(req._crossSource.permissionFq, 'owner:alice')
      assert.include(req._crossSource.permissionFq, 'user_read:alice')
    })

    it('always produces a filter for sp_gene — it is not publicFree', function () {
      // If sp_gene were ever added to publicFree this would go null legitimately;
      // pin the current reality so a config change is a visible test failure.
      const req = { call_collection: 'genome_feature', sourceParams, _rawBody: '', publicFree, user: 'bob' }
      run(req)
      assert.isNotNull(req._crossSource.permissionFq)
    })

    it('carries ctx in the shape enrichDocs/enrichDocsChained expect', function () {
      const req = {
        call_collection: 'genome_feature', sourceParams, _rawBody: '', publicFree, user: 'alice'
      }
      run(req)
      assert.deepEqual(req._crossSource.ctx, { user: 'alice', publicFree })
    })
  })

  describe('source query capture', function () {
    const sourceParams = { http_source_collection: 'sp_gene', http_source_link_field: 'feature_id' }

    it('preserves the RAW body, not the target-parsed query', function () {
      // RQLQueryParser has already rewritten call_params[0] against the TARGET
      // collection, which is wrong for the source. Phase 3 re-parses rawQuery
      // against the source collection instead.
      const raw = 'genome(and(eq(taxon_lineage_ids,114185),ne(genome_status,Deprecated)))'
      const req = {
        call_collection: 'genome_feature',
        sourceParams,
        _rawBody: raw,
        call_params: ['&q=*:*&fq=SOMETHING_TARGET_SHAPED'],
        publicFree
      }
      run(req)
      assert.equal(req._crossSource.rawQuery, raw)
    })

    it('tolerates a missing body', function () {
      const req = { call_collection: 'genome_feature', sourceParams, publicFree }
      const { nexted } = run(req)
      assert.isTrue(nexted)
      assert.equal(req._crossSource.rawQuery, '')
    })

    it('exposes a batch size for the source cursor', function () {
      const req = { call_collection: 'genome_feature', sourceParams, _rawBody: '', publicFree }
      run(req)
      assert.isNumber(req._crossSource.batchSize)
      assert.isAbove(req._crossSource.batchSize, 0)
    })
  })
})

describe('http-params http_source_* capture', function () {
  const httpParams = require('../../middleware/http-params')

  function runParams (url) {
    const req = { url, headers: {} }
    let nexted = false
    httpParams(req, {}, () => { nexted = true })
    assert.isTrue(nexted)
    return req
  }

  it('captures http_source_* into req.sourceParams', function () {
    const req = runParams('/?http_source_collection=sp_gene&http_source_link_field=feature_id')
    assert.equal(req.sourceParams.http_source_collection, 'sp_gene')
    assert.equal(req.sourceParams.http_source_link_field, 'feature_id')
  })

  it('strips them from the query so they never reach Solr', function () {
    const req = runParams('/?eq(a,b)&http_source_collection=sp_gene&http_source_link_field=feature_id')
    assert.notInclude(req.url, 'http_source_collection')
    assert.notInclude(req.url, 'http_source_link_field')
    assert.include(req.url, 'eq(a,b)')
  })

  it('does not promote them to headers', function () {
    // http-params only promotes an allowlist of four header names; source params
    // must not become headers even accidentally.
    const req = runParams('/?http_source_collection=sp_gene&http_source_link_field=feature_id')
    assert.isUndefined(req.headers.source)
  })
})
