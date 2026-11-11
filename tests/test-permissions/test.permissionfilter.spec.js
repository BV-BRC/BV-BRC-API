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
  isDocVisible,
  normalizeOwners,
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

describe('permissionFilter publicOwners', function () {
  const publicOwners = ['PATRIC@patricbrc.org', 'curator']

  it('defaults to no extra owners (fq unchanged)', function () {
    assert.equal(buildPermissionFq({ collection: 'genome', publicFree }), 'public:true')
  })

  it('widens the anonymous filter', function () {
    assert.equal(
      buildPermissionFq({ collection: 'genome', publicFree, publicOwners }),
      '(public:true OR owner:PATRIC@patricbrc.org OR owner:curator)'
    )
  })

  it('widens the authenticated filter', function () {
    assert.equal(
      buildPermissionFq({ collection: 'genome', user: 'alice', publicFree, publicOwners }),
      '(public:true OR owner:PATRIC@patricbrc.org OR owner:curator OR owner:alice OR user_read:alice)'
    )
  })

  it('does not filter publicFree collections', function () {
    assert.isNull(buildPermissionFq({ collection: 'taxonomy', publicFree, publicOwners }))
  })

  it('escapes owner ids so they cannot widen the filter further', function () {
    const fq = buildPermissionFq({ collection: 'genome', publicFree, publicOwners: ['x) OR *:*'] })
    assert.equal(fq, '(public:true OR owner:x\\) OR \\*\\:\\*)')
  })

  it('normalizes comma-separated strings, trims and de-duplicates', function () {
    assert.deepEqual(normalizeOwners(' a, b ,a,, '), ['a', 'b'])
    assert.deepEqual(normalizeOwners(undefined), [])
    assert.deepEqual(normalizeOwners(''), [])
  })

  it('rejects non-string entries', function () {
    assert.throws(() => normalizeOwners([1]), /publicOwners/)
  })

  it('leaves the scope key alone (rows are visible under every scope)', function () {
    assert.equal(permissionScopeKey({ collection: 'genome', publicFree, publicOwners }), 'public')
  })

  describe('isDocVisible', function () {
    const priv = { public: false, owner: 'curator', user_read: [] }
    const other = { public: false, owner: 'bob', user_read: ['carol'] }

    it('shows a public-owner private doc to anonymous callers', function () {
      assert.isTrue(isDocVisible(priv, { collection: 'genome', publicFree, publicOwners }))
      assert.isFalse(isDocVisible(priv, { collection: 'genome', publicFree, publicOwners: [] }))
    })

    it('keeps other private docs hidden', function () {
      assert.isFalse(isDocVisible(other, { collection: 'genome', publicFree, publicOwners }))
      assert.isFalse(isDocVisible(other, { collection: 'genome', user: 'alice', publicFree, publicOwners }))
      assert.isTrue(isDocVisible(other, { collection: 'genome', user: 'carol', publicFree, publicOwners }))
      assert.isTrue(isDocVisible(other, { collection: 'genome', user: 'bob', publicFree, publicOwners }))
    })

    it('honors public and publicFree', function () {
      assert.isTrue(isDocVisible({ public: true, owner: 'bob' }, { collection: 'genome', publicFree }))
      assert.isTrue(isDocVisible(other, { collection: 'taxonomy', publicFree }))
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
