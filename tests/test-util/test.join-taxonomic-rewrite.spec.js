/**
 * Taxon-subtree join rewrite, with deprecated-genome exclusion.
 *
 * Offline: both Solr lookups are stubs. What is pinned here is the SHAPE of the emitted
 * query and the decisions around it; the numbers that justify the design were measured
 * against live Solr and are recorded in Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md
 * §4.1a.
 *
 * The case that matters most is "omits the exclusion when the list is too large" — a
 * subtree filter emitted WITHOUT its exclusion silently over-counts (1,949,521 vs
 * 1,625,381 on Influenza A, a 20% error returned as HTTP 200). Falling back to the
 * untouched join is the only safe failure.
 */

const assert = require('chai').assert
const Config = require('../../config')
const jr = require('../../lib/joinResolver')

const JOIN = (filter) =>
  `q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}${filter}&rows=25`

function stubs ({ taxa = [], excluded = [], genomeCount = 2000000 } = {}) {
  const calls = { genome: [], taxonomy: [] }
  const page = (docs, field) => ({
    response: { numFound: docs.length, docs: docs.map((v) => ({ [field]: v })) },
    nextCursorMark: 'END'
  })
  return {
    calls,
    queryGenome: async ({ query }) => {
      calls.genome.push(query)
      // NB the fq is URL-encoded by the caller, so ':' arrives as %3A.
      const isStatusQuery = /genome_status(?::|%3A)/i.test(query)
      if (/rows=0/.test(query)) {
        // Two different rows=0 counts reach this stub: the join's genome count, and the
        // pre-check that sizes the exclusion list before paging it.
        return { response: { numFound: isStatusQuery ? excluded.length : genomeCount, docs: [] } }
      }
      if (isStatusQuery) {
        // cursor-paged exclusion fetch: one page then stop
        if (/cursorMark=END/.test(query)) return { response: { numFound: 0, docs: [] }, nextCursorMark: 'END' }
        return page(excluded, 'genome_id')
      }
      // The genome_id fallback path (fetchGenomeIds). Return as many ids as the filter
      // claims to match, so a stub that says "100,000 genomes" cannot then hand back
      // three ids and make the fallback look like a successful rewrite.
      return page(Array.from({ length: Math.min(genomeCount, 5) }, (_, i) => `g${i}.1`), 'genome_id')
    },
    queryTaxonomy: async ({ query }) => {
      calls.taxonomy.push(query)
      if (/rows=0/.test(query)) return { response: { numFound: taxa.length, docs: [] } }
      if (/cursorMark=END/.test(query)) return { response: { numFound: 0, docs: [] }, nextCursorMark: 'END' }
      return page(taxa, 'taxon_id')
    }
  }
}

describe('taxon-subtree join rewrite', function () {
  let saved

  beforeEach(function () {
    jr.clearCaches()
    saved = Config.get('joinResolution')
    Config.set('joinResolution', Object.assign({}, saved, { taxonomicRewrite: true }))
  })

  afterEach(function () {
    Config.set('joinResolution', saved)
    jr.clearCaches()
  })

  describe('parseTaxonomicFilter', function () {
    it('accepts a bare lineage filter', function () {
      assert.deepEqual(jr.parseTaxonomicFilter('taxon_lineage_ids:2955291'),
        { taxonId: '2955291', excludeStatus: null })
    })

    it('accepts the parenthesised AND !genome_status form that rql.js emits', function () {
      assert.deepEqual(
        jr.parseTaxonomicFilter('(taxon_lineage_ids:2955291 AND !genome_status:Deprecated)'),
        { taxonId: '2955291', excludeStatus: 'Deprecated' })
    })

    it('accepts the - negation spelling as well as !', function () {
      assert.deepEqual(
        jr.parseTaxonomicFilter('taxon_lineage_ids:2 AND -genome_status:Deprecated'),
        { taxonId: '2', excludeStatus: 'Deprecated' })
    })

    it('REJECTS a filter carrying anything else', function () {
      // The whole safety argument rests on this: a filter we mis-parse yields a silently
      // wrong row count, so anything unrecognised must fall through to the genome_id path.
      ;['genome_status:Complete',
        'taxon_lineage_ids:2 AND host_name:Human',
        'taxon_lineage_ids:2 OR taxon_lineage_ids:3',
        'taxon_lineage_ids:2 AND !genome_status:Deprecated AND public:true'
      ].forEach((f) => assert.isNull(jr.parseTaxonomicFilter(f), f))
    })
  })

  describe('emitted query', function () {
    it('rewrites to a taxon_id inclusion minus a genome_id exclusion', async function () {
      const s = stubs({ taxa: ['11320', '197911'], excluded: ['1.1', '2.2'] })
      const r = await jr.resolveJoins(
        JOIN('(taxon_lineage_ids:2955291 AND !genome_status:Deprecated)'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy, collection: 'genome_sequence' })

      assert.include(r.query, '&fq={!terms f=taxon_id cache=true}11320,197911')
      assert.include(r.query, '&fq=-{!terms f=genome_id cache=true}1.1,2.2')
      assert.notInclude(r.query, 'crossCollection')
      assert.equal(r.rewrites[0].strategy, 'taxon-subtree')
      assert.equal(r.rewrites[0].excludedCount, 2)
    })

    it('omits the exclusion when the filter negates nothing', async function () {
      const s = stubs({ taxa: ['11320'] })
      const r = await jr.resolveJoins(JOIN('taxon_lineage_ids:2955291'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })
      assert.include(r.query, '{!terms f=taxon_id')
      assert.notInclude(r.query, '-{!terms f=genome_id')
    })

    it('runs for a taxon FAR over rejectMaxGenomes, instead of rejecting it', async function () {
      // Influenza A is ~1.6M genomes against a 150,000 reject threshold. The whole point
      // of this path is that those are exactly the queries worth rewriting.
      const s = stubs({ taxa: ['11320'], excluded: ['1.1'], genomeCount: 1625381 })
      const r = await jr.resolveJoins(
        JOIN('(taxon_lineage_ids:2955291 AND !genome_status:Deprecated)'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })
      assert.equal(r.rewrites.length, 1)
      assert.include(r.query, '{!terms f=taxon_id')
    })
  })

  describe('safety', function () {
    it('falls back to the untouched join when the exclusion list is too large', async function () {
      // MUST NOT emit the subtree alone — that over-counts by every deprecated genome.
      Config.set('joinResolution',
        Object.assign({}, Config.get('joinResolution'), { exclusionMaxIds: 1 }))
      // genomeCount sits in the LEAVE-ALONE band (>rewriteMaxGenomes 50k,
      // <rejectMaxGenomes 150k) so that falling through to the genome_id path neither
      // rewrites nor rejects — leaving the intact join as the observable signal.
      const s = stubs({ taxa: ['11320'], excluded: ['1.1', '2.2', '3.3'], genomeCount: 100000 })
      const r = await jr.resolveJoins(
        JOIN('(taxon_lineage_ids:2955291 AND !genome_status:Deprecated)'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })
      // The assertion that matters: the subtree must NOT be emitted. Emitting it without
      // its exclusion is the silent-20%-over-count failure this cap exists to prevent.
      // What happens afterwards (intact join, or the genome_id path picking it up) is the
      // pre-existing behaviour and is covered elsewhere.
      assert.notInclude(r.query, 'f=taxon_id')
      assert.notOk(r.rewrites.some((w) => w.strategy === 'taxon-subtree'))
    })

    it('sizes the lists BEFORE paging them — the Viruses case', async function () {
      // Viruses (10239) is 274,702 subtree taxa and 702,579 deprecated genomes against
      // caps of 250,000/400,000, and 14.9M live genomes so it is refused anyway. Without
      // the rows=0 pre-check this burned 13 cursor pages (~260,000 ids) discovering that.
      // Production already fails this query: HTTP 500 at 120s on both genome_sequence and
      // genome_feature, measured 2026-10-27.
      Config.set('joinResolution',
        Object.assign({}, Config.get('joinResolution'), { subtreeMaxTaxa: 100 }))
      const s = stubs({ taxa: Array.from({ length: 500 }, (_, i) => String(i)), genomeCount: 100000 })
      await jr.resolveJoins(JOIN('taxon_lineage_ids:10239'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })

      const counts = s.calls.taxonomy.filter((q) => /rows=0/.test(q)).length
      const pages = s.calls.taxonomy.filter((q) => /cursorMark/.test(q)).length
      assert.equal(counts, 1, 'one rows=0 count')
      assert.equal(pages, 0, 'and NO cursor paging — that is the whole point')
    })

    it('falls back when the subtree is too large', async function () {
      Config.set('joinResolution',
        Object.assign({}, Config.get('joinResolution'), { subtreeMaxTaxa: 1 }))
      const s = stubs({ taxa: ['1', '2', '3'], genomeCount: 100000 })
      const r = await jr.resolveJoins(JOIN('taxon_lineage_ids:2955291'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })
      assert.include(r.query, 'crossCollection')
    })

    it('falls back when no taxonomy lookup is supplied', async function () {
      const s = stubs({ taxa: ['11320'], genomeCount: 100000 })
      const r = await jr.resolveJoins(JOIN('taxon_lineage_ids:2955291'),
        { queryGenome: s.queryGenome })
      assert.include(r.query, 'crossCollection')
    })

    it('is inert unless taxonomicRewrite is enabled', async function () {
      Config.set('joinResolution',
        Object.assign({}, Config.get('joinResolution'), { taxonomicRewrite: false }))
      const s = stubs({ taxa: ['11320'], genomeCount: 1625381 })
      try {
        const r = await jr.resolveJoins(JOIN('taxon_lineage_ids:2955291'),
          { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy })
        assert.include(r.query, 'crossCollection')
      } catch (e) {
        // the old path rejects a 1.6M-genome join, which is also "not rewritten"
        assert.instanceOf(e, jr.JoinTooBroadError)
      }
      assert.lengthOf(s.calls.taxonomy, 0, 'must not touch taxonomy when disabled')
    })
  })

  describe('cacheDirective', function () {
    it('caches by default and on an explicit true', function () {
      assert.equal(jr.cacheDirective(undefined), 'cache=true')
      assert.equal(jr.cacheDirective(true), 'cache=true')
    })

    it('only disables caching on an explicit false', function () {
      assert.equal(jr.cacheDirective(false), 'cache=false')
    })

    it('threads through to the emitted filter', async function () {
      const s = stubs({ taxa: ['11320'] })
      const r = await jr.resolveJoins(JOIN('taxon_lineage_ids:2955291'),
        { queryGenome: s.queryGenome, queryTaxonomy: s.queryTaxonomy, filterCache: false })
      assert.include(r.query, '{!terms f=taxon_id cache=false}')
    })
  })
})
