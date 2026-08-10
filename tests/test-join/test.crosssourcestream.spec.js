/**
 * CrossCollectionSourceStream — source cursor -> target docs
 *
 * Phase 3 of PLAN_CROSS_COLLECTION_DOWNLOAD.md.
 *
 * Properties under test:
 *   - source and target are permission-scoped INDEPENDENTLY (different
 *     collections, potentially different publicFree status)
 *   - resolution is batched, so memory does not scale with match count
 *   - output is a plain object-mode stream of target docs, so existing media
 *     serializers consume it unchanged
 */

const assert = require('chai').assert
const CrossCollectionSourceStream = require('../../lib/CrossCollectionSourceStream')
const { buildCursorSort } = CrossCollectionSourceStream

const publicFree = ['feature_sequence', 'taxonomy']

/**
 * Mock DirectSolrClient with cursor support that applies only the fq it is given
 * — the same fidelity choice as the enrichment tests. A hop that forgets its
 * filter therefore reads everything, exactly as in production.
 */
class MockSolr {
  constructor (source = [], target = []) {
    this.source = source
    this.target = target
    this.cursorCalls = []
    this.fetchCalls = []
  }

  _visible (doc, fq) {
    if (!fq) return true
    if (fq === 'public:true') return doc.public === true
    const m = fq.match(/^\(public:true OR owner:(.+) OR user_read:\1\)$/)
    if (m) {
      const u = m[1].replace(/\\(.)/g, '$1')
      return doc.public === true || doc.owner === u ||
        (Array.isArray(doc.user_read) && doc.user_read.includes(u))
    }
    throw new Error(`Mock cannot parse fq: ${fq}`)
  }

  async queryWithCursor (collection, params) {
    this.cursorCalls.push({ collection, params })

    const fqs = Array.isArray(params.fq) ? params.fq : (params.fq ? [params.fq] : [])
    // Treat any fq that looks like a permission clause as one; others are the
    // caller's filter, applied here as a simple field:value match.
    let rows = this.source.filter((d) => {
      for (const fq of fqs) {
        if (/public:true/.test(fq)) {
          if (!this._visible(d, fq)) return false
        } else {
          const [f, v] = fq.split(':')
          if (String(d[f]) !== v) return false
        }
      }
      return true
    })

    const rows2 = rows.slice()
    rows2.sort((a, b) => String(a.id).localeCompare(String(b.id)))

    const start = params.cursorMark === '*' ? 0 : parseInt(params.cursorMark, 10)
    const size = params.rows || 10
    const page = rows2.slice(start, start + size)
    const next = start + page.length

    return {
      response: { docs: page, numFound: rows2.length },
      // Solr's contract: when exhausted it echoes back the mark you SENT (which
      // on the first call is '*', not an offset). Returning String(start) here
      // instead made the first page repeat forever.
      nextCursorMark: next >= rows2.length ? params.cursorMark : String(next)
    }
  }

  async fetchByIds (collection, field, values, options = {}) {
    this.fetchCalls.push({ collection, field, values, options })
    return this.target.filter((d) =>
      values.includes(d[field]) && this._visible(d, options.permissionFq))
  }
}

function collect (stream) {
  return new Promise((resolve, reject) => {
    const out = []
    stream.on('data', (d) => out.push(d))
    stream.on('end', () => resolve(out))
    stream.on('error', reject)
  })
}

// sp_gene rows (source) referencing genome_feature rows (target).
const SOURCE = [
  { id: 's1', feature_id: 'f.pub', public: true, owner: 'PATRIC' },
  { id: 's2', feature_id: 'f.alice', public: false, owner: 'alice' },
  { id: 's3', feature_id: 'f.pub', public: true, owner: 'PATRIC' }, // dup link value
  { id: 's4', feature_id: 'f.bob', public: false, owner: 'bob' }
]

const TARGET = [
  { feature_id: 'f.pub', patric_id: 'fig|1', public: true, owner: 'PATRIC' },
  { feature_id: 'f.alice', patric_id: 'fig|2', public: false, owner: 'alice' },
  { feature_id: 'f.bob', patric_id: 'fig|3', public: false, owner: 'bob' }
]

function makeStream (solr, overrides = {}) {
  return new CrossCollectionSourceStream({
    solrClient: solr,
    sourceCollection: 'sp_gene',
    targetCollection: 'genome_feature',
    linkField: 'feature_id',
    batchSize: 10,
    // Tests assert on raw target docs; the Solr-style metadata header is
    // covered by its own test below.
    emitHeader: false,
    ...overrides
  })
}

describe('targetFieldList — serializer join-key injection', function () {
  const { targetFieldList } = require('../../middleware/CrossCollectionStream')

  const fl = (list, accept) => targetFieldList({
    call_params: ['&q=*:*' + (list ? '&fl=' + list : '')],
    headers: { accept }
  })

  it('injects aa_sequence_md5 for protein FASTA', function () {
    // Without this, select(patric_id) yields a download of correct headers with
    // empty sequence bodies — the serializer joins to feature_sequence itself
    // and never receives the md5 to join on. JoinFieldInjector protects the
    // ordinary request path; cross-collection resolution bypasses it.
    assert.include(fl('patric_id', 'application/protein+fasta').split(','), 'aa_sequence_md5')
  })

  it('injects na_sequence_md5 for DNA FASTA', function () {
    assert.include(fl('patric_id', 'application/dna+fasta').split(','), 'na_sequence_md5')
  })

  it('preserves the client-requested fields', function () {
    assert.include(fl('patric_id,product', 'application/protein+fasta').split(','), 'patric_id')
    assert.include(fl('patric_id,product', 'application/protein+fasta').split(','), 'product')
  })

  it('does not duplicate a field the client already selected', function () {
    const out = fl('patric_id,aa_sequence_md5', 'application/protein+fasta').split(',')
    assert.equal(out.filter((f) => f === 'aa_sequence_md5').length, 1)
  })

  it('injects nothing for formats that need no join key', function () {
    assert.equal(fl('patric_id', 'text/csv'), 'patric_id')
  })

  it('returns null (all fields) when the client selected nothing', function () {
    assert.isNull(fl(null, 'application/protein+fasta'))
  })
})

describe('buildCursorSort', function () {
  it('defaults to the uniqueKey ascending', function () {
    assert.equal(buildCursorSort(null, 'id'), 'id asc')
  })

  it('appends the uniqueKey to a caller sort that lacks it', function () {
    assert.equal(buildCursorSort('genome_id asc', 'id'), 'genome_id asc, id asc')
  })

  it('leaves a sort that already contains the uniqueKey alone', function () {
    assert.equal(buildCursorSort('id desc', 'id'), 'id desc')
    assert.equal(buildCursorSort('genome_id asc,id asc', 'id'), 'genome_id asc,id asc')
  })
})

describe('CrossCollectionSourceStream', function () {
  describe('construction', function () {
    it('requires the core options', function () {
      assert.throws(() => new CrossCollectionSourceStream({}), /solrClient is required/)
    })

    it('refuses a source collection with no configured uniqueKey', function () {
      // Without a uniqueKey there is no valid cursor sort, and Solr would 400
      // per page. Fail at construction with an actionable message instead.
      assert.throws(() => makeStream(new MockSolr(), { sourceCollection: 'not_a_collection' }),
        /no uniqueKey configured/)
    })

    it('derives a cursor sort containing the source uniqueKey', function () {
      const s = makeStream(new MockSolr())
      assert.include(s.sourceSort, 'id') // sp_gene uniqueKey is 'id'
    })
  })

  describe('resolution', function () {
    it('streams target docs for the source query', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      const docs = await collect(makeStream(solr, { ctx: { user: 'alice', publicFree } }))

      const ids = docs.map((d) => d.feature_id).sort()
      assert.deepEqual(ids, ['f.alice', 'f.pub'], 'alice sees public + her own')
    })

    it('dedups repeated link values before querying the target', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      await collect(makeStream(solr, { ctx: { user: 'alice', publicFree } }))

      // s1 and s3 both point at f.pub — the terms list must carry it once.
      const asked = solr.fetchCalls[0].values
      assert.equal(new Set(asked).size, asked.length, 'no duplicate link values')
    })

    it('pages the source with a cursor across multiple batches', async function () {
      const many = []
      for (let i = 0; i < 25; i++) {
        many.push({ id: `s${String(i).padStart(3, '0')}`, feature_id: `f${i}`, public: true })
      }
      const targets = many.map((s) => ({ feature_id: s.feature_id, public: true }))

      const solr = new MockSolr(many, targets)
      const docs = await collect(makeStream(solr, { batchSize: 10, ctx: { publicFree } }))

      assert.equal(docs.length, 25)
      assert.isAbove(solr.cursorCalls.length, 1, 'must have paged')
      // Batch size is respected — this is what bounds memory.
      solr.cursorCalls.forEach((c) => assert.equal(c.params.rows, 10))
    })

    it('ends cleanly on an empty source', async function () {
      const solr = new MockSolr([], TARGET)
      const docs = await collect(makeStream(solr, { ctx: { publicFree } }))
      assert.deepEqual(docs, [])
    })

    it('keeps going when a batch resolves to zero visible target docs', async function () {
      // A whole batch can vanish to permissions or dangling refs; that must not
      // be read as end-of-stream.
      const source = [
        { id: 's1', feature_id: 'f.alice', public: true },
        { id: 's2', feature_id: 'f.pub', public: true }
      ]
      const solr = new MockSolr(source, TARGET)
      const docs = await collect(makeStream(solr, { batchSize: 1, ctx: { user: 'bob', publicFree } }))

      // f.alice is invisible to bob; f.pub must still arrive.
      assert.deepEqual(docs.map((d) => d.feature_id), ['f.pub'])
    })

    it('dedups link values ACROSS batches, not just within one', async function () {
      // Regression: the source is sorted by its uniqueKey, not the link field,
      // so rows sharing a link value scatter across cursor pages. Per-batch
      // dedup alone emits the same target document once per page it appears in.
      // Found on real data — 1793 sp_gene rows yielded 1708 "deduped" values but
      // only 965 distinct, i.e. 743 duplicate FASTA records.
      const source = [
        { id: 's1', feature_id: 'fA', public: true },
        { id: 's2', feature_id: 'fB', public: true },
        { id: 's3', feature_id: 'fA', public: true }, // same link, later page
        { id: 's4', feature_id: 'fB', public: true }
      ]
      const target = [
        { feature_id: 'fA', public: true },
        { feature_id: 'fB', public: true }
      ]
      const solr = new MockSolr(source, target)

      // batchSize 2 puts s1/s2 in page 1 and s3/s4 in page 2.
      const docs = await collect(makeStream(solr, { batchSize: 2, ctx: { publicFree } }))

      assert.equal(docs.length, 2, 'each target document exactly once')
      assert.deepEqual(docs.map((d) => d.feature_id).sort(), ['fA', 'fB'])

      // The second page must not even ask the target for values already resolved.
      const secondFetch = solr.fetchCalls[1]
      if (secondFetch) {
        assert.notInclude(secondFetch.values, 'fA')
        assert.notInclude(secondFetch.values, 'fB')
      }
    })

    it('produces identical output regardless of batch size', async function () {
      const source = []
      const target = []
      for (let i = 0; i < 12; i++) {
        // Three source rows per feature, interleaved so they span pages.
        source.push({ id: `s${String(i).padStart(3, '0')}`, feature_id: `f${i % 4}`, public: true })
      }
      for (let i = 0; i < 4; i++) target.push({ feature_id: `f${i}`, public: true })

      const runs = []
      for (const batchSize of [1, 3, 100]) {
        const solr = new MockSolr(source, target)
        const docs = await collect(makeStream(solr, { batchSize, ctx: { publicFree } }))
        runs.push(docs.map((d) => d.feature_id).sort().join(','))
      }

      assert.equal(runs[0], runs[1])
      assert.equal(runs[1], runs[2])
      assert.equal(runs[0], 'f0,f1,f2,f3')
    })

    it('handles a ONE-TO-MANY link without truncating', async function () {
      // Regression: DirectSolrClient.fetchByIds defaults its row cap to
      // values.length, which assumes one target doc per link value. That holds
      // for sp_gene.feature_id -> genome_feature but NOT for
      // genome.genome_id -> genome_sequence, where one genome has many contigs.
      // Observed as a 105-contig download returning 2 records — one per genome.
      const source = [
        { id: 'g1', genome_id: 'gA', public: true },
        { id: 'g2', genome_id: 'gB', public: true }
      ]
      const target = []
      for (let i = 0; i < 60; i++) target.push({ genome_id: 'gA', sequence_id: `gA.${i}`, public: true })
      for (let i = 0; i < 45; i++) target.push({ genome_id: 'gB', sequence_id: `gB.${i}`, public: true })

      const solr = new MockSolr(source, target)
      const docs = await collect(makeStream(solr, {
        sourceCollection: 'genome',
        targetCollection: 'genome_sequence',
        linkField: 'genome_id',
        ctx: { publicFree }
      }))

      assert.equal(docs.length, 105, 'every contig, not one per genome')
      assert.equal(docs.filter((d) => d.genome_id === 'gA').length, 60)
      assert.equal(docs.filter((d) => d.genome_id === 'gB').length, 45)

      // The row cap sent must exceed the link count, or Solr truncates.
      assert.isAbove(solr.fetchCalls[0].options.rows, 2)
    })

    it('emits a Solr-style metadata header document by default', async function () {
      // Regression: the media serializers skip the first document
      // (streamWithBackpressure skipFirstDoc defaults to true) because a Solrjs
      // stream leads with a metadata doc. A stream that omits it silently loses
      // its first real record — observed as a 965-row resolution producing a
      // 964-row CSV.
      const solr = new MockSolr(SOURCE, TARGET)
      const docs = await collect(new CrossCollectionSourceStream({
        solrClient: solr,
        sourceCollection: 'sp_gene',
        targetCollection: 'genome_feature',
        linkField: 'feature_id',
        ctx: { user: 'alice', publicFree }
      }))

      assert.isObject(docs[0].response, 'first doc is the metadata header')
      assert.isUndefined(docs[0].feature_id, 'header is not a target doc')
      // Both real docs survive behind the header.
      assert.deepEqual(docs.slice(1).map((d) => d.feature_id).sort(), ['f.alice', 'f.pub'])
    })

    it('reports stats', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      const s = makeStream(solr, { ctx: { user: 'alice', publicFree } })
      await collect(s)
      const stats = s.getStats()
      assert.equal(stats.sourceRows, 4)
      assert.equal(stats.targetDocs, 2)
      assert.isAbove(stats.batches, 0)
    })
  })

  describe('independent permission scoping', function () {
    it('applies the caller-supplied source fq to the source cursor', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      await collect(makeStream(solr, {
        sourcePermissionFq: '(public:true OR owner:alice OR user_read:alice)',
        ctx: { user: 'alice', publicFree }
      }))

      const fqs = solr.cursorCalls[0].params.fq
      assert.include(fqs.join(' '), 'owner:alice')
    })

    it('computes the TARGET fq from the target collection, not the source', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      await collect(makeStream(solr, { ctx: { user: 'alice', publicFree } }))

      const fq = solr.fetchCalls[0].options.permissionFq
      assert.isNotNull(fq, 'genome_feature is not publicFree')
      assert.include(fq, 'owner:alice')
    })

    it('sends no target fq when the target collection is publicFree', async function () {
      const solr = new MockSolr(
        [{ id: 's1', md5: 'abc', public: true }],
        [{ md5: 'abc', sequence: 'ATG' }]
      )
      await collect(new CrossCollectionSourceStream({
        solrClient: solr,
        sourceCollection: 'sp_gene',
        targetCollection: 'feature_sequence',
        linkField: 'md5',
        emitHeader: false,
        ctx: { user: 'alice', publicFree }
      }))

      assert.isNull(solr.fetchCalls[0].options.permissionFq)
    })

    it('does not leak private target rows to a non-owner', async function () {
      // Source row is public and names a private target — the download analogue
      // of the enrichment IDOR.
      const source = [{ id: 's1', feature_id: 'f.alice', public: true, owner: 'PATRIC' }]
      const solr = new MockSolr(source, TARGET)

      const docs = await collect(makeStream(solr, { ctx: { user: 'bob', publicFree } }))

      assert.deepEqual(docs, [], "bob must not receive alice's private feature")
    })

    it('gives the owner their own private target rows', async function () {
      const source = [{ id: 's1', feature_id: 'f.alice', public: true, owner: 'PATRIC' }]
      const solr = new MockSolr(source, TARGET)

      const docs = await collect(makeStream(solr, { ctx: { user: 'alice', publicFree } }))

      assert.deepEqual(docs.map((d) => d.feature_id), ['f.alice'])
    })

    it('anonymous gets only public target rows', async function () {
      const solr = new MockSolr(SOURCE, TARGET)
      const docs = await collect(makeStream(solr, { ctx: { publicFree } }))
      assert.deepEqual(docs.map((d) => d.feature_id), ['f.pub'])
    })
  })
})
