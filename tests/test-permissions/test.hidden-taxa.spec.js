/**
 * hiddenPublicTaxa: public rows in configured taxonomic subtrees are hidden from every
 * read path, while rows visible through ownership stay visible. See lib/hiddenTaxa.js.
 *
 * Offline: the taxonomy query is injected.
 */

const assert = require('chai').assert
const hiddenTaxa = require('../../lib/hiddenTaxa')
const { makeState, MATCH_ALL } = hiddenTaxa
const { buildPermissionFq, isDocVisible, permissionScopeKey } = require('../../lib/permissionFilter')
const DecorateQuery = require('../../middleware/DecorateQuery')
const Limiter = require('../../middleware/Limiter')
const { publicFree } = require('../../middleware/PublicDataTypes')

const ROOTS = [197911, 197912]
const LINEAGE = 'taxon_lineage_ids:(197911 OR 197912)'
// a tiny stand-in subtree: the roots, a species node, and two strains
const SUBTREE = ['197911', '197912', '11320', '11520', '1701435']

const resolved = makeState({ roots: ROOTS, taxonIds: SUBTREE })
const unresolved = makeState({ roots: ROOTS, taxonIds: null })
const disabled = makeState({ roots: [], taxonIds: null })
const TERMS = `_query_:"{!terms f=taxon_id}${resolved.taxonIds.join(',')}"`

describe('hiddenPublicTaxa', function () {
  describe('buildPermissionFq', function () {
    it('is a no-op when no roots are configured', function () {
      assert.equal(buildPermissionFq({ collection: 'genome', publicFree, hiddenTaxa: disabled }), 'public:true')
      assert.isNull(buildPermissionFq({ collection: 'epitope', publicFree, hiddenTaxa: disabled }))
    })

    it('narrows the public term on a lineage collection (anonymous)', function () {
      assert.equal(
        buildPermissionFq({ collection: 'genome', publicFree, hiddenTaxa: resolved }),
        `(public:true AND NOT ${LINEAGE})`
      )
    })

    it('keeps ownership terms intact (authenticated + publicOwners)', function () {
      assert.equal(
        buildPermissionFq({ collection: 'genome', user: 'alice', publicFree, publicOwners: ['lowvan@bvbrc'], hiddenTaxa: resolved }),
        `((public:true AND NOT ${LINEAGE}) OR owner:lowvan@bvbrc OR owner:alice OR user_read:alice)`
      )
    })

    it('uses the resolved subtree on a taxon_id collection', function () {
      assert.equal(
        buildPermissionFq({ collection: 'genome_feature', publicFree, hiddenTaxa: resolved }),
        `(public:true AND NOT ${TERMS})`
      )
    })

    it('FAILS CLOSED on a taxon_id collection before the subtree is resolved', function () {
      assert.equal(
        buildPermissionFq({ collection: 'genome_feature', publicFree, hiddenTaxa: unresolved }),
        `(public:true AND NOT ${MATCH_ALL})`
      )
      // ownership still works while public rows are withheld
      assert.include(
        buildPermissionFq({ collection: 'genome_feature', user: 'alice', publicFree, hiddenTaxa: unresolved }),
        'owner:alice OR user_read:alice'
      )
      // a lineage collection does not need the subtree and is unaffected
      assert.equal(
        buildPermissionFq({ collection: 'genome', publicFree, hiddenTaxa: unresolved }),
        `(public:true AND NOT ${LINEAGE})`
      )
    })

    it('filters publicFree collections it covers, which used to get no fq at all', function () {
      assert.equal(
        buildPermissionFq({ collection: 'epitope', publicFree, hiddenTaxa: resolved }),
        `(*:* AND NOT ${LINEAGE})`
      )
      assert.equal(
        buildPermissionFq({ collection: 'protein_feature', user: 'alice', publicFree, hiddenTaxa: resolved }),
        `(*:* AND NOT ${TERMS})`
      )
    })

    it('leaves uncovered collections alone (taxonomy, feature_sequence)', function () {
      assert.isNull(buildPermissionFq({ collection: 'taxonomy', publicFree, hiddenTaxa: resolved }))
      assert.isNull(buildPermissionFq({ collection: 'feature_sequence', publicFree, hiddenTaxa: resolved }))
    })

    it('does not change the cache scope key (the clause is the same for everyone)', function () {
      assert.equal(permissionScopeKey({ collection: 'genome', publicFree }), 'public')
      assert.equal(permissionScopeKey({ collection: 'genome', user: 'alice', publicFree }), 'user:alice')
    })
  })

  describe('isDocVisible', function () {
    const ctx = (extra) => ({ collection: 'genome', publicFree, hiddenTaxa: resolved, ...extra })
    const fluPublic = { public: true, owner: 'PATRIC@patricbrc.org', taxon_id: 1701435, taxon_lineage_ids: [11308, 197911, 11320, 1701435] }
    const ecoli = { public: true, owner: 'PATRIC@patricbrc.org', taxon_id: 562, taxon_lineage_ids: [2, 1224, 562] }

    it('hides a public row in a hidden taxon from anonymous and unrelated users', function () {
      assert.isFalse(isDocVisible(fluPublic, ctx()))
      assert.isFalse(isDocVisible(fluPublic, ctx({ user: 'alice' })))
    })

    it('still shows non-hidden public rows', function () {
      assert.isTrue(isDocVisible(ecoli, ctx()))
    })

    it('shows a hidden-taxon row to its owner, readers, and via publicOwners', function () {
      const mine = { ...fluPublic, owner: 'alice', user_read: ['bob'] }
      assert.isTrue(isDocVisible(mine, ctx({ user: 'alice' })))
      assert.isTrue(isDocVisible(mine, ctx({ user: 'bob' })))
      const lowvan = { ...fluPublic, public: false, owner: 'lowvan@bvbrc' }
      assert.isTrue(isDocVisible(lowvan, ctx({ publicOwners: ['lowvan@bvbrc'] })))
    })

    it('falls back to taxon_lineage_ids when the doc has no taxon_id', function () {
      const doc = { public: true, owner: 'x', taxon_lineage_ids: [11308, 197912, 11520] }
      assert.isFalse(isDocVisible(doc, ctx()))
      assert.isFalse(isDocVisible(doc, ctx({ hiddenTaxa: unresolved })))
    })

    it('fails closed for a taxon_id collection before the subtree is resolved', function () {
      const gf = { public: true, owner: 'x', taxon_id: 562 }
      assert.isFalse(isDocVisible(gf, { collection: 'genome_feature', publicFree, hiddenTaxa: unresolved }))
      assert.isTrue(isDocVisible(gf, { collection: 'genome_feature', publicFree, hiddenTaxa: resolved }))
    })

    it('applies to publicFree collections it covers', function () {
      const ep = { taxon_lineage_ids: [11308, 197911, 11320] }
      assert.isFalse(isDocVisible(ep, { collection: 'epitope', publicFree, hiddenTaxa: resolved }))
      assert.isTrue(isDocVisible(ep, { collection: 'taxonomy', publicFree, hiddenTaxa: resolved }))
    })
  })

  describe('middleware interaction', function () {
    before(function () {
      hiddenTaxa.configure({ roots: ROOTS })
      hiddenTaxa.setTaxonIds(Array.from({ length: 5000 }, (_, i) => String(100000 + i)))
    })
    after(function () { hiddenTaxa.configure({ roots: [] }) })

    it('DecorateQuery appends the narrowed filter from the live state', function () {
      const req = { call_method: 'query', call_collection: 'genome_feature', call_params: ['&q=*:*&rows=25'], publicFree }
      DecorateQuery(req, {}, () => {})
      assert.include(req.call_params[0], '&fq=(public:true AND NOT _query_:"{!terms f=taxon_id}100000,')
    })

    it('Limiter does not mistake the injected subtree for a fixed id list', function () {
      // detectFixedIdCount caps rows to idCount+10 for an `&fq={!terms ...}` on a primary
      // key. The injected clause is neither fq-anchored nor on a primary key; pin that, so
      // rows=20000 is not rewritten to 5010 (or the reverse, a 25-row page raised).
      for (const collection of ['genome_feature', 'genome', 'taxonomy']) {
        const req = { call_method: 'query', call_collection: collection, call_params: ['&q=*:*&rows=20000'], publicFree, headers: {}, requestId: 't' }
        DecorateQuery(req, {}, () => {})
        const log = console.log
        console.log = () => {}
        try { Limiter(req, {}, () => {}) } finally { console.log = log }
        assert.match(req.call_params[0], /&rows=20000\b/, collection)
      }
    })
  })

  describe('refresh', function () {
    const facet = (ids) => async () => ({
      facet_counts: { facet_fields: { taxon_id: Object.fromEntries(ids.map((i) => [String(i), 1])) } }
    })
    beforeEach(function () { hiddenTaxa.configure({ roots: ROOTS }) })
    after(function () { hiddenTaxa.configure({ roots: [] }) })

    it('is a no-op when disabled', async function () {
      hiddenTaxa.configure({ roots: [] })
      assert.isFalse(await hiddenTaxa.refresh(facet(SUBTREE)))
    })

    it('resolves the subtree and sends the expected query', async function () {
      let sent
      const ok = await hiddenTaxa.refresh(async (q) => { sent = q; return facet(SUBTREE)() })
      assert.isTrue(ok)
      assert.include(sent, 'q=lineage_ids:(197911 OR 197912)')
      assert.include(sent, 'facet.limit=-1')
      assert.sameMembers(hiddenTaxa.getState().taxonIds, SUBTREE)
      assert.notEqual(hiddenTaxa.hiddenTaxaClause('genome_feature'), MATCH_ALL)
    })

    it('keeps the current list when the query fails', async function () {
      await hiddenTaxa.refresh(facet(SUBTREE))
      assert.isFalse(await hiddenTaxa.refresh(async () => { throw new Error('boom') }))
      assert.lengthOf(hiddenTaxa.getState().taxonIds, SUBTREE.length)
    })

    it('rejects a result missing a root', async function () {
      assert.isFalse(await hiddenTaxa.refresh(facet(['197911', '11320'])))
      assert.isNull(hiddenTaxa.getState().taxonIds, 'still unresolved, still failing closed')
    })

    it('rejects a refresh that shrinks the list sharply (taxonomy mid-reload)', async function () {
      const big = ['197911', '197912', ...Array.from({ length: 1000 }, (_, i) => String(i + 1))]
      await hiddenTaxa.refresh(facet(big))
      assert.isFalse(await hiddenTaxa.refresh(facet(big.slice(0, 500))))
      assert.lengthOf(hiddenTaxa.getState().taxonIds, big.length)
      // ordinary growth is accepted
      assert.isTrue(await hiddenTaxa.refresh(facet([...big, '999999'])))
    })
  })

  describe('config validation', function () {
    it('rejects non-numeric roots (they are interpolated into Solr)', function () {
      assert.throws(() => makeState({ roots: ['197911) OR *:*'] }), /numeric/)
    })
    it('rejects an unknown filter field', function () {
      assert.throws(() => makeState({ roots: ROOTS, collections: { genome: 'owner' } }), /field must be/)
    })
  })
})
