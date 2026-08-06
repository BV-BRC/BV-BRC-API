/**
 * Unit tests for lib/permissionFilter.js
 *
 * Part 1 of PLAN_ENRICHMENT_PERMISSIONS.md — the shared permission-fq helper.
 * These tests pin the semantics that DecorateQuery previously inlined, so the
 * extraction cannot silently change what the primary query filters on.
 */

const assert = require('chai').assert
const {
  buildPermissionFq,
  permissionScopeKey,
  permissionContext,
  escapeSolrValue
} = require('../../lib/permissionFilter')

// A representative slice of the real allowlist (middleware/PublicDataTypes.js).
// Note what is NOT here: `genome` — the target of every configured join.
const publicFree = ['taxonomy', 'feature_sequence', 'protein_feature']

describe('permissionFilter', function () {
  describe('buildPermissionFq', function () {
    it('returns null for publicFree collections (anonymous)', function () {
      assert.isNull(buildPermissionFq({ collection: 'feature_sequence', publicFree }))
    })

    it('returns null for publicFree collections (authenticated)', function () {
      assert.isNull(buildPermissionFq({ collection: 'feature_sequence', user: 'alice', publicFree }))
    })

    it('returns public-only filter when there is no user', function () {
      assert.equal(buildPermissionFq({ collection: 'genome', publicFree }), 'public:true')
    })

    it('returns the owner/user_read triple when a user is present', function () {
      assert.equal(
        buildPermissionFq({ collection: 'genome', user: 'alice', publicFree }),
        '(public:true OR owner:alice OR user_read:alice)'
      )
    })

    it('filters when publicFree is absent entirely (fail closed)', function () {
      // DecorateQuery's original `!req.publicFree` branch: no allowlist means
      // nothing is exempt, so the filter must still be applied.
      assert.equal(buildPermissionFq({ collection: 'genome' }), 'public:true')
      assert.equal(
        buildPermissionFq({ collection: 'genome', user: 'alice' }),
        '(public:true OR owner:alice OR user_read:alice)'
      )
    })

    it('does NOT exempt genome — it is not publicFree', function () {
      // This is the premise the plan originally got wrong; pin it.
      const realishAllowlist = ['taxonomy', 'feature_sequence', 'protein_feature',
        'antibiotics', 'epitope', 'bioset', 'surveillance']
      assert.isNotNull(buildPermissionFq({
        collection: 'genome', user: 'alice', publicFree: realishAllowlist
      }))
    })

    it('escapes Solr special characters in the user value', function () {
      const fq = buildPermissionFq({ collection: 'genome', user: 'a b) OR public:true OR (x', publicFree })
      // The injected `)` must not close the filter's paren group.
      assert.include(fq, '\\)')
      assert.include(fq, '\\(')
    })
  })

  describe('permissionScopeKey', function () {
    it('uses the shared public scope for publicFree collections', function () {
      assert.equal(permissionScopeKey({ collection: 'feature_sequence', user: 'alice', publicFree }), 'public')
      assert.equal(permissionScopeKey({ collection: 'feature_sequence', user: 'bob', publicFree }), 'public')
    })

    it('uses the shared public scope for anonymous requests', function () {
      assert.equal(permissionScopeKey({ collection: 'genome', publicFree }), 'public')
    })

    it('gives distinct scopes to distinct users on filtered collections', function () {
      const a = permissionScopeKey({ collection: 'genome', user: 'alice', publicFree })
      const b = permissionScopeKey({ collection: 'genome', user: 'bob', publicFree })
      assert.notEqual(a, b)
      assert.equal(a, 'user:alice')
    })

    it('separates an authenticated scope from the public scope', function () {
      assert.notEqual(
        permissionScopeKey({ collection: 'genome', user: 'alice', publicFree }),
        permissionScopeKey({ collection: 'genome', publicFree })
      )
    })
  })

  describe('permissionContext', function () {
    it('derives fq and scope key from the same inputs', function () {
      const ctx = permissionContext({ collection: 'genome', user: 'alice', publicFree })
      assert.equal(ctx.permissionFq, '(public:true OR owner:alice OR user_read:alice)')
      assert.equal(ctx.scopeKey, 'user:alice')
    })

    it('reports no filter and the public scope for exempt collections', function () {
      const ctx = permissionContext({ collection: 'taxonomy', user: 'alice', publicFree })
      assert.isNull(ctx.permissionFq)
      assert.equal(ctx.scopeKey, 'public')
    })
  })

  describe('escapeSolrValue', function () {
    it('leaves ordinary user ids untouched', function () {
      // Real-world ids must round-trip unchanged, byte for byte.
      assert.equal(escapeSolrValue('olsonanl@patricbrc.org'), 'olsonanl@patricbrc.org')
      assert.equal(escapeSolrValue('user123'), 'user123')
    })

    it('escapes query-breaking characters', function () {
      assert.equal(escapeSolrValue('a:b'), 'a\\:b')
      assert.equal(escapeSolrValue('a b'), 'a b') // whitespace is not special inside a term clause
      assert.equal(escapeSolrValue('a"b'), 'a\\"b')
    })
  })
})

describe('DecorateQuery (permission fq parity)', function () {
  const DecorateQuery = require('../../middleware/DecorateQuery')

  function run (req) {
    let called = false
    DecorateQuery(req, {}, () => { called = true })
    assert.isTrue(called, 'next() must always be called')
    return req.call_params && req.call_params[0]
  }

  it('appends public:true for anonymous requests', function () {
    const q = run({ call_method: 'query', call_collection: 'genome', call_params: ['&q=*:*'], publicFree })
    assert.equal(q, '&q=*:*&fq=public:true')
  })

  it('appends the owner triple for authenticated requests', function () {
    const q = run({
      call_method: 'query', call_collection: 'genome', call_params: ['&q=*:*'], publicFree, user: 'alice'
    })
    assert.equal(q, '&q=*:*&fq=(public:true OR owner:alice OR user_read:alice)')
  })

  it('appends nothing for publicFree collections', function () {
    const q = run({
      call_method: 'query', call_collection: 'taxonomy', call_params: ['&q=*:*'], publicFree, user: 'alice'
    })
    assert.equal(q, '&q=*:*')
  })

  it('defaults an empty query to *:* before filtering', function () {
    const q = run({ call_method: 'query', call_collection: 'genome', call_params: [], publicFree })
    assert.equal(q, '&q=*:*&fq=public:true')
  })

  it('is a no-op for non-query methods', function () {
    const req = { call_method: 'stream', call_collection: 'genome', call_params: ['&q=*:*'], publicFree }
    run(req)
    assert.equal(req.call_params[0], '&q=*:*')
  })
})
