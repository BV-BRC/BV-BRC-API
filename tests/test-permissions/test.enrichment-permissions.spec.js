/**
 * Permission-aware join enrichment — security tests
 *
 * Implements the test plan in PLAN_ENRICHMENT_PERMISSIONS.md. These are the
 * merge gate for the enrichment permission fix.
 *
 * The mock Solr client below enforces permissions the way Solr actually would:
 * it applies whatever `fq` it is handed and NOTHING else. That is the whole
 * point — the real Solr has no ACLs here, the API is the permission layer, so
 * a fetch that forgets the fq reads everything. A mock that filtered by itself
 * would hide exactly the bug these tests exist to catch.
 */

const assert = require('chai').assert
const BatchJoiner = require('../../lib/BatchJoiner')
const JoinEnrichmentStream = require('../../lib/distributed/JoinEnrichmentStream')
const GenomeMetadataJoinStream = require('../../lib/distributed/GenomeMetadataJoinStream')

// Realistic slice of middleware/PublicDataTypes.js. `genome` is deliberately
// absent — it is NOT publicFree, which is why any of this matters.
const publicFree = ['taxonomy', 'feature_sequence', 'protein_feature']

const GENOMES = {
  'pub.1': { genome_id: 'pub.1', genome_name: 'Public Genome', public: true, owner: 'alice' },
  'priv.alice': { genome_id: 'priv.alice', genome_name: 'Alice Secret Genome', public: false, owner: 'alice', user_read: ['alice'] },
  'priv.bob': { genome_id: 'priv.bob', genome_name: 'Bob Secret Genome', public: false, owner: 'bob', user_read: ['bob'] },
  'priv.shared': { genome_id: 'priv.shared', genome_name: 'Shared Genome', public: false, owner: 'alice', user_read: ['alice', 'bob'] }
}

/**
 * Mock Solr that honors ONLY the fq it is given.
 *
 * Recognizes the two shapes lib/permissionFilter emits:
 *   public:true
 *   (public:true OR owner:<u> OR user_read:<u>)
 */
class PermissionAwareMockSolr {
  constructor (data = GENOMES) {
    this.data = data
    this.calls = []
  }

  _visible (doc, permissionFq) {
    // No fq: Solr returns everything. This is the vulnerable path.
    if (!permissionFq) return true

    if (permissionFq === 'public:true') return doc.public === true

    const m = permissionFq.match(/^\(public:true OR owner:(.+) OR user_read:\1\)$/)
    if (m) {
      const user = m[1].replace(/\\(.)/g, '$1') // undo escapeSolrValue
      return doc.public === true ||
        doc.owner === user ||
        (Array.isArray(doc.user_read) && doc.user_read.includes(user))
    }

    throw new Error(`Mock does not understand fq: ${permissionFq}`)
  }

  async fetchByIdsAsDict (collection, keyField, values, options = {}) {
    this.calls.push({ collection, keyField, values, options })

    const out = {}
    for (const v of values) {
      const doc = this.data[v]
      if (doc && this._visible(doc, options.permissionFq)) {
        out[v] = doc
      }
    }
    return out
  }

  async fetchGenomeMetadata (genomeIds, fields, options = {}) {
    return this.fetchByIdsAsDict('genome', 'genome_id', genomeIds, options)
  }

  lastCall () { return this.calls[this.calls.length - 1] }
  reset () { this.calls = [] }
}

const GENOME_NAME_SPEC = {
  targetCollection: 'genome',
  localField: 'genome_id',
  foreignField: 'genome_id',
  fields: ['genome_name']
}

describe('Join enrichment permissions', function () {
  describe('1. Owner sees, non-owner does not (direct fetch path)', function () {
    it('enriches a private genome for its owner', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f1', genome_id: 'priv.alice' }]

      await joiner.enrichDocs(docs, GENOME_NAME_SPEC, { user: 'alice', publicFree })

      assert.equal(docs[0].genome_name, 'Alice Secret Genome')
    })

    it('does NOT leak a private genome to a different user', async function () {
      // The regression test — fails against the pre-fix code.
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f1', genome_id: 'priv.alice' }]

      await joiner.enrichDocs(docs, GENOME_NAME_SPEC, { user: 'bob', publicFree })

      assert.isUndefined(docs[0].genome_name, 'bob must not see alice\'s private genome name')
    })

    it('does NOT leak a private genome to an anonymous request', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f1', genome_id: 'priv.alice' }]

      await joiner.enrichDocs(docs, GENOME_NAME_SPEC, { publicFree })

      assert.isUndefined(docs[0].genome_name)
    })

    it('honors user_read sharing', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)
      const docs = [{ feature_id: 'f1', genome_id: 'priv.shared' }]

      await joiner.enrichDocs(docs, GENOME_NAME_SPEC, { user: 'bob', publicFree })

      assert.equal(docs[0].genome_name, 'Shared Genome', 'bob is in user_read')
    })

    it('sends a permission fq on the genome fetch at all', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      await joiner.enrichDocs([{ genome_id: 'pub.1' }], GENOME_NAME_SPEC, { user: 'alice', publicFree })

      const call = solr.lastCall()
      assert.isNotNull(call.options.permissionFq, 'genome is not publicFree — fq is required')
      assert.include(call.options.permissionFq, 'owner:alice')
    })
  })

  describe('2. Cache leak (must fail against a fetch-only fix)', function () {
    it('does not serve a private row cached for user A to user B', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr) // ONE joiner — mirrors the process-wide singleton

      // Warm the cache as alice.
      const aliceDocs = [{ genome_id: 'priv.alice' }]
      await joiner.enrichDocs(aliceDocs, GENOME_NAME_SPEC, { user: 'alice', publicFree })
      assert.equal(aliceDocs[0].genome_name, 'Alice Secret Genome', 'precondition: cache is warm')

      // Bob asks for the same key against the warm cache.
      const bobDocs = [{ genome_id: 'priv.alice' }]
      await joiner.enrichDocs(bobDocs, GENOME_NAME_SPEC, { user: 'bob', publicFree })

      assert.isUndefined(bobDocs[0].genome_name,
        'bob must not receive alice\'s private row from the shared cache')
    })

    it('does not serve a private row to an anonymous request from a warm cache', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      await joiner.enrichDocs([{ genome_id: 'priv.alice' }], GENOME_NAME_SPEC, { user: 'alice', publicFree })

      const anonDocs = [{ genome_id: 'priv.alice' }]
      await joiner.enrichDocs(anonDocs, GENOME_NAME_SPEC, { publicFree })

      assert.isUndefined(anonDocs[0].genome_name)
    })

    it('re-fetches per scope rather than reusing another scope entry', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      await joiner.enrichDocs([{ genome_id: 'priv.alice' }], GENOME_NAME_SPEC, { user: 'alice', publicFree })
      const afterAlice = solr.calls.length

      await joiner.enrichDocs([{ genome_id: 'priv.alice' }], GENOME_NAME_SPEC, { user: 'bob', publicFree })

      assert.isAbove(solr.calls.length, afterAlice,
        'bob\'s scope must trigger its own fetch, not reuse alice\'s cache entry')
    })
  })

  describe('3. Public data is unchanged and still shares cache', function () {
    it('enriches public genomes for everyone', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      for (const ctx of [{ user: 'alice', publicFree }, { user: 'bob', publicFree }, { publicFree }]) {
        const docs = [{ genome_id: 'pub.1' }]
        await joiner.enrichDocs(docs, GENOME_NAME_SPEC, ctx)
        assert.equal(docs[0].genome_name, 'Public Genome')
      }
    })

    it('shares one cache entry across users for a publicFree target', async function () {
      // feature_sequence IS publicFree → scope key is `public` for everyone,
      // so the cache is shared and hit-rate is preserved.
      const seqSolr = new PermissionAwareMockSolr({
        abc123: { md5: 'abc123', sequence: 'ATGC', public: true }
      })
      const joiner = new BatchJoiner(seqSolr)
      const spec = {
        targetCollection: 'feature_sequence',
        localField: 'md5',
        foreignField: 'md5',
        fields: ['sequence']
      }

      await joiner.enrichDocs([{ md5: 'abc123' }], spec, { user: 'alice', publicFree })
      const afterAlice = seqSolr.calls.length

      const bobDocs = [{ md5: 'abc123' }]
      await joiner.enrichDocs(bobDocs, spec, { user: 'bob', publicFree })

      assert.equal(seqSolr.calls.length, afterAlice, 'publicFree target: cache is shared')
      assert.equal(bobDocs[0].sequence, 'ATGC')
      assert.isNull(seqSolr.calls[0].options.permissionFq, 'publicFree → no fq')
    })
  })

  describe('4. Streaming parity', function () {
    function collect (stream) {
      return new Promise((resolve, reject) => {
        const out = []
        stream.on('data', d => out.push(d))
        stream.on('end', () => resolve(out))
        stream.on('error', reject)
      })
    }

    it('JoinEnrichmentStream: owner sees, non-owner does not', async function () {
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      const asAlice = new JoinEnrichmentStream(joiner, {
        joinSpecs: [GENOME_NAME_SPEC], batchSize: 2, skipHeader: false,
        user: 'alice', publicFree
      })
      const alicePromise = collect(asAlice)
      asAlice.write({ genome_id: 'priv.alice' })
      asAlice.end()
      const aliceOut = await alicePromise
      assert.equal(aliceOut[0].genome_name, 'Alice Secret Genome')

      const asBob = new JoinEnrichmentStream(joiner, {
        joinSpecs: [GENOME_NAME_SPEC], batchSize: 2, skipHeader: false,
        user: 'bob', publicFree
      })
      const bobPromise = collect(asBob)
      asBob.write({ genome_id: 'priv.alice' })
      asBob.end()
      const bobOut = await bobPromise
      assert.isUndefined(bobOut[0].genome_name, 'streaming path must not leak either')
    })

    it('JoinEnrichmentStream: shared joiner cache does not leak across streams', async function () {
      // Both streams share the singleton joiner, as they do in production.
      const solr = new PermissionAwareMockSolr()
      const joiner = new BatchJoiner(solr)

      const warm = new JoinEnrichmentStream(joiner, {
        joinSpecs: [GENOME_NAME_SPEC], batchSize: 1, skipHeader: false, user: 'alice', publicFree
      })
      const warmP = collect(warm)
      warm.write({ genome_id: 'priv.alice' })
      warm.end()
      await warmP

      const cold = new JoinEnrichmentStream(joiner, {
        joinSpecs: [GENOME_NAME_SPEC], batchSize: 1, skipHeader: false, user: 'bob', publicFree
      })
      const coldP = collect(cold)
      cold.write({ genome_id: 'priv.alice' })
      cold.end()
      const out = await coldP

      assert.isUndefined(out[0].genome_name)
    })

    // This stream attaches metadata as a nested object under `attachAs`
    // (default 'genome_metadata'), so assert on that rather than a top-level
    // field — a top-level assertion would pass vacuously.
    it('GenomeMetadataJoinStream: filters its own (independent) fetch', async function () {
      const solr = new PermissionAwareMockSolr()

      const asBob = new GenomeMetadataJoinStream(solr, {
        batchSize: 1, skipHeader: false,
        genomeFields: ['genome_id', 'genome_name'],
        user: 'bob', publicFree
      })
      const p = collect(asBob)
      asBob.write({ genome_id: 'priv.alice' })
      asBob.end()
      const out = await p

      assert.isUndefined(out[0].genome_metadata, 'FASTA genome join must not leak private genomes')
      assert.isNotNull(solr.lastCall().options.permissionFq)
    })

    it('GenomeMetadataJoinStream: owner still gets their private genome', async function () {
      const solr = new PermissionAwareMockSolr()

      const asAlice = new GenomeMetadataJoinStream(solr, {
        batchSize: 1, skipHeader: false,
        genomeFields: ['genome_id', 'genome_name'],
        user: 'alice', publicFree
      })
      const p = collect(asAlice)
      asAlice.write({ genome_id: 'priv.alice' })
      asAlice.end()
      const out = await p

      assert.isObject(out[0].genome_metadata, 'owner must get their own genome metadata')
      assert.equal(out[0].genome_metadata.genome_name, 'Alice Secret Genome')
    })
  })

  describe('5. Error path does not poison the cache', function () {
    it('retries after a transient failure instead of caching null', async function () {
      let n = 0
      const flaky = {
        async fetchByIdsAsDict () {
          n++
          if (n === 1) throw new Error('Solr connection reset')
          return { 'pub.1': GENOMES['pub.1'] }
        }
      }
      const joiner = new BatchJoiner(flaky)

      const first = [{ genome_id: 'pub.1' }]
      await joiner.enrichDocs(first, GENOME_NAME_SPEC, { user: 'alice', publicFree })
      assert.isUndefined(first[0].genome_name)

      const second = [{ genome_id: 'pub.1' }]
      await joiner.enrichDocs(second, GENOME_NAME_SPEC, { user: 'alice', publicFree })
      assert.equal(second[0].genome_name, 'Public Genome', 'must retry, not serve poisoned null')
    })
  })
})
