/**
 * enrichDocsChained — multi-hop join driver
 *
 * Phase 2c of PLAN_CROSS_COLLECTION_DOWNLOAD.md.
 *
 * The load-bearing property here is PER-HOP permission scoping. A chain is only
 * as scoped as its weakest hop, and the hops span collections with different
 * publicFree status, so a single shared fq is wrong in both directions. The mock
 * below enforces permissions the way Solr actually does — it applies whatever fq
 * it is handed and nothing else — so a hop that forgets its filter reads
 * everything, exactly as it would in production.
 */

const assert = require('chai').assert
const BatchJoiner = require('../../lib/BatchJoiner')
const { buildChainedSpec, buildJoinSpecs, getRequiredJoinKeys } = require('../../lib/joinConfig')

// genome_feature is NOT publicFree; feature_sequence IS. That asymmetry is the
// whole point of scoping per hop.
const publicFree = ['feature_sequence', 'taxonomy']

const DATA = {
  genome_feature: {
    'f.pub': { feature_id: 'f.pub', aa_sequence_md5: 'md5pub', public: true, owner: 'PATRIC' },
    'f.alice': { feature_id: 'f.alice', aa_sequence_md5: 'md5alice', public: false, owner: 'alice' },
    'f.bob': { feature_id: 'f.bob', aa_sequence_md5: 'md5bob', public: false, owner: 'bob' }
  },
  feature_sequence: {
    md5pub: { md5: 'md5pub', sequence: 'PUBLICSEQ', public: true },
    md5alice: { md5: 'md5alice', sequence: 'ALICESEQ', public: true },
    md5bob: { md5: 'md5bob', sequence: 'BOBSEQ', public: true }
  }
}

class PermissionAwareMockSolr {
  constructor (data = DATA) {
    this.data = data
    this.calls = []
  }

  _visible (doc, fq) {
    if (!fq) return true // no filter => Solr returns everything (the vulnerable path)
    if (fq === 'public:true') return doc.public === true
    const m = fq.match(/^\(public:true OR owner:(.+) OR user_read:\1\)$/)
    if (m) {
      const user = m[1].replace(/\\(.)/g, '$1')
      return doc.public === true || doc.owner === user ||
        (Array.isArray(doc.user_read) && doc.user_read.includes(user))
    }
    throw new Error(`Mock cannot parse fq: ${fq}`)
  }

  async fetchByIdsAsDict (collection, keyField, values, options = {}) {
    this.calls.push({ collection, keyField, values, options })
    const src = this.data[collection] || {}
    const out = {}
    for (const v of values) {
      // Key by the requested keyField, not assuming it is the dict key.
      const row = Object.values(src).find((d) => d[keyField] === v)
      if (row && this._visible(row, options.permissionFq)) out[v] = row
    }
    return out
  }

  callsFor (collection) { return this.calls.filter((c) => c.collection === collection) }
  reset () { this.calls = [] }
}

// sp_gene.feature_id -> genome_feature.aa_sequence_md5 -> feature_sequence.sequence
const AA_CHAIN = buildChainedSpec('aa_sequence', {
  path: [
    { from: 'genome_feature', localField: 'feature_id', foreignField: 'feature_id', carry: 'aa_sequence_md5' },
    { from: 'feature_sequence', localField: 'aa_sequence_md5', foreignField: 'md5', field: 'sequence' }
  ]
})

describe('joinConfig — path grammar', function () {
  it('builds a two-hop chained spec', function () {
    assert.isTrue(AA_CHAIN.chained)
    assert.equal(AA_CHAIN.outputField, 'aa_sequence')
    assert.equal(AA_CHAIN.hops.length, 2)
    assert.equal(AA_CHAIN.hops[0].carry, 'aa_sequence_md5')
    assert.equal(AA_CHAIN.hops[1].field, 'sequence')
  })

  it('rejects an intermediate hop with no carry', function () {
    assert.isNull(buildChainedSpec('x', {
      path: [
        { from: 'a', localField: 'k', foreignField: 'k' }, // no carry, not last
        { from: 'b', localField: 'k2', foreignField: 'k2', field: 'v' }
      ]
    }))
  })

  it('rejects a final hop with no field', function () {
    assert.isNull(buildChainedSpec('x', {
      path: [{ from: 'a', localField: 'k', foreignField: 'k', carry: 'c' }]
    }))
  })

  it('rejects a hop missing from/localField/foreignField', function () {
    assert.isNull(buildChainedSpec('x', { path: [{ from: 'a', field: 'v' }] }))
  })

  it('keeps single-hop specs working (back-compat)', function () {
    const specs = buildJoinSpecs(['genome_name'], {
      genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' }
    })
    assert.equal(specs.length, 1)
    assert.isUndefined(specs[0].chained)
    assert.equal(specs[0].targetCollection, 'genome')
  })

  it('mixes single-hop and chained specs in one request', function () {
    const specs = buildJoinSpecs(['genome_name', 'aa_sequence'], {
      genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
      aa_sequence: {
        path: [
          { from: 'genome_feature', localField: 'feature_id', foreignField: 'feature_id', carry: 'aa_sequence_md5' },
          { from: 'feature_sequence', localField: 'aa_sequence_md5', foreignField: 'md5', field: 'sequence' }
        ]
      }
    })
    assert.equal(specs.length, 2)
    assert.equal(specs.filter((s) => s.chained).length, 1)
  })

  it('injects the FIRST hop key for a chained field', function () {
    // Later hops are keyed by carried values, not by fields on the source doc.
    const keys = getRequiredJoinKeys(['aa_sequence'], {
      aa_sequence: {
        path: [
          { from: 'genome_feature', localField: 'feature_id', foreignField: 'feature_id', carry: 'aa_sequence_md5' },
          { from: 'feature_sequence', localField: 'aa_sequence_md5', foreignField: 'md5', field: 'sequence' }
        ]
      }
    })
    assert.deepEqual(Array.from(keys), ['feature_id'])
  })
})

describe('BatchJoiner.enrichDocsChained', function () {
  describe('resolution', function () {
    it('walks two hops and attaches the terminal field', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ id: 'sp1', feature_id: 'f.pub' }]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'alice', publicFree })

      assert.equal(docs[0].aa_sequence, 'PUBLICSEQ')
    })

    it('queries each hop against its own collection', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      await j.enrichDocsChained([{ feature_id: 'f.pub' }], AA_CHAIN, { user: 'alice', publicFree })

      assert.equal(solr.callsFor('genome_feature').length, 1)
      assert.equal(solr.callsFor('feature_sequence').length, 1)
    })

    it('leaves the field absent when the chain breaks at hop 1', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ feature_id: 'does.not.exist' }]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'alice', publicFree })

      assert.isUndefined(docs[0].aa_sequence)
    })

    it('dedups shared intermediate keys across docs', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      // Three docs, same feature -> one md5 -> one sequence lookup.
      const docs = [{ feature_id: 'f.pub' }, { feature_id: 'f.pub' }, { feature_id: 'f.pub' }]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'alice', publicFree })

      assert.equal(solr.callsFor('feature_sequence')[0].values.length, 1)
      docs.forEach((d) => assert.equal(d.aa_sequence, 'PUBLICSEQ'))
    })

    it('is a no-op on empty input', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      assert.deepEqual(await j.enrichDocsChained([], AA_CHAIN, { publicFree }), [])
      assert.equal(solr.calls.length, 0)
    })

    it('does not start when no doc carries the first-hop key', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ id: 'sp1' }] // no feature_id
      await j.enrichDocsChained(docs, AA_CHAIN, { publicFree })
      assert.equal(solr.calls.length, 0, 'must not issue a fetch with no keys')
    })
  })

  describe('per-hop permission scoping', function () {
    it('sends a permission fq for the filtered hop and none for the exempt hop', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      await j.enrichDocsChained([{ feature_id: 'f.pub' }], AA_CHAIN, { user: 'alice', publicFree })

      const gfCall = solr.callsFor('genome_feature')[0]
      const fsCall = solr.callsFor('feature_sequence')[0]

      assert.isNotNull(gfCall.options.permissionFq, 'genome_feature is not publicFree')
      assert.include(gfCall.options.permissionFq, 'owner:alice')
      assert.isNull(fsCall.options.permissionFq, 'feature_sequence IS publicFree')
    })

    it('does not leak a private INTERMEDIATE row to another user', async function () {
      // The private row is at hop 1 (genome_feature), not the terminal hop. If
      // only the first or only the last hop were scoped, this would leak.
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f.alice' }]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'bob', publicFree })

      assert.isUndefined(docs[0].aa_sequence,
        "bob must not obtain the sequence behind alice's private feature")
    })

    it('resolves the same private row for its owner', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f.alice' }]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'alice', publicFree })

      assert.equal(docs[0].aa_sequence, 'ALICESEQ')
    })

    it('withholds a private intermediate row from anonymous', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f.alice' }]
      await j.enrichDocsChained(docs, AA_CHAIN, { publicFree })
      assert.isUndefined(docs[0].aa_sequence)
    })

    it('does not serve a private chain result across users from a warm cache', async function () {
      // Same singleton-cache gate as the single-hop enrichment tests.
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)

      const asAlice = [{ feature_id: 'f.alice' }]
      await j.enrichDocsChained(asAlice, AA_CHAIN, { user: 'alice', publicFree })
      assert.equal(asAlice[0].aa_sequence, 'ALICESEQ', 'precondition: cache warm')

      const asBob = [{ feature_id: 'f.alice' }]
      await j.enrichDocsChained(asBob, AA_CHAIN, { user: 'bob', publicFree })

      assert.isUndefined(asBob[0].aa_sequence, 'warm cache must not cross the scope boundary')
    })

    it('mixed batch: each user sees only their own private rows', async function () {
      const solr = new PermissionAwareMockSolr()
      const j = new BatchJoiner(solr)
      const docs = [
        { feature_id: 'f.pub' },
        { feature_id: 'f.alice' },
        { feature_id: 'f.bob' }
      ]

      await j.enrichDocsChained(docs, AA_CHAIN, { user: 'bob', publicFree })

      assert.equal(docs[0].aa_sequence, 'PUBLICSEQ')
      assert.isUndefined(docs[1].aa_sequence, "alice's row withheld from bob")
      assert.equal(docs[2].aa_sequence, 'BOBSEQ', 'bob keeps his own')
    })
  })
})
