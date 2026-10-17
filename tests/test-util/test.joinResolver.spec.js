/**
 * Cross-collection join admission (lib/joinResolver.js).
 *
 * The defect: `{!join method=crossCollection fromIndex=genome ...}` over a broad genome
 * set materializes a DocSet per shard and holds it for the life of the query. That
 * OOM-crashed three Solr data nodes on 2026-06-25, and still fails today — measured
 * against production 2026-10-15, taxon 10239 (Viruses, 15.6M genomes) and
 * `genome_status:Complete` (10.3M genomes) each time out at 120s, deterministically.
 *
 * Two behaviors are pinned here: refusing a join that is too broad (the OOM guard), and
 * rewriting a small one into a local {!terms} filter (measured 3-6x faster with identical
 * numFound).
 *
 * Fully offline — the genome lookup is injected, so no Solr/Redis/API.
 */

const assert = require('chai').assert

const {
  resolveJoins,
  findJoins,
  clearCaches,
  getThresholds,
  JoinTooBroadError
} = require('../../lib/joinResolver')

// Build a stub genome lookup that reports `count` genomes and returns synthetic ids.
// Records every query it receives so tests can assert on the lookups themselves.
function stubGenomeQuery (count, opts = {}) {
  const calls = []
  const fn = async ({ query }) => {
    calls.push(query)
    if (opts.fail) {
      throw new Error(opts.failMessage || 'solr unavailable')
    }
    if (/rows=0/.test(query)) {
      return { response: { numFound: count, docs: [] } }
    }
    const docs = []
    for (let i = 0; i < count; i++) {
      docs.push({ genome_id: `${1000 + i}.1` })
    }
    return { response: { numFound: count, docs } }
  }
  fn.calls = calls
  return fn
}

const TRAILING_JOIN =
  '&q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:1386&rows=25'

const V_PARAM_JOIN =
  'q=*:*&fq=feature_type:(CDS OR mat_peptide)&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id v=taxon_lineage_ids:10239}&rows=0'

describe('joinResolver', () => {
  beforeEach(() => clearCaches())

  describe('findJoins', () => {
    it('matches the form lib/solrjs/rql.js emits (filter after the brace)', () => {
      const joins = findJoins(TRAILING_JOIN)
      assert.lengthOf(joins, 1)
      assert.strictEqual(joins[0].filter, 'taxon_lineage_ids:1386')
      assert.strictEqual(joins[0].toField, 'genome_id')
    })

    it('matches the form routes/dataRouter.js emits (filter in v=)', () => {
      // summary_by_taxon uses this spelling. Missing it would leave the endpoint whose
      // timeouts started this investigation unprotected.
      const joins = findJoins(V_PARAM_JOIN)
      assert.lengthOf(joins, 1)
      assert.strictEqual(joins[0].filter, 'taxon_lineage_ids:10239')
    })

    it('captures a parenthesised multi-clause filter whole', () => {
      const q = '&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}(taxon_lineage_ids:1386 AND genome_status:Complete)'
      assert.strictEqual(findJoins(q)[0].filter, '(taxon_lineage_ids:1386 AND genome_status:Complete)')
    })

    it('captures a non-default to= field', () => {
      const q = '&fq={!join method=crossCollection fromIndex=genome from=genome_id to=gid}genome_status:Complete'
      assert.strictEqual(findJoins(q)[0].toField, 'gid')
    })

    it('finds nothing in a query with no join', () => {
      assert.lengthOf(findJoins('q=*:*&rows=10'), 0)
      assert.lengthOf(findJoins(''), 0)
      assert.lengthOf(findJoins(null), 0)
    })

    it('is not left stateful between calls by the global regex', () => {
      // JOIN_RE is /g; a leaked lastIndex would make the second call miss.
      assert.lengthOf(findJoins(TRAILING_JOIN), 1)
      assert.lengthOf(findJoins(TRAILING_JOIN), 1)
    })
  })

  describe('rejecting an over-broad join (the OOM guard)', () => {
    it('THE GUARD: refuses a join above rejectMaxGenomes with a 400', async () => {
      const { rejectMaxGenomes } = getThresholds()
      const queryGenome = stubGenomeQuery(rejectMaxGenomes + 1)

      try {
        await resolveJoins(TRAILING_JOIN, { queryGenome })
        assert.fail('expected JoinTooBroadError')
      } catch (err) {
        assert.instanceOf(err, JoinTooBroadError)
        assert.strictEqual(err.status, 400, 'app.js reads .status')
        assert.strictEqual(err.statusCode, 400, 'internalQuery/dataRouter read .statusCode')
        assert.strictEqual(err.genomeCount, rejectMaxGenomes + 1)
      }
    })

    it('never issues the id fetch for a rejected join', async () => {
      // The point is to avoid the expensive work, so it must bail after the count.
      const { rejectMaxGenomes } = getThresholds()
      const queryGenome = stubGenomeQuery(rejectMaxGenomes + 1)

      try {
        await resolveJoins(TRAILING_JOIN, { queryGenome })
      } catch (err) { /* expected */ }

      assert.lengthOf(queryGenome.calls, 1, 'should stop after the count query')
      assert.match(queryGenome.calls[0], /rows=0/)
    })

    it('names the count and the limit, so the message is actionable', async () => {
      const queryGenome = stubGenomeQuery(1382167) // Bacteria, measured 2026-10-12
      try {
        await resolveJoins(TRAILING_JOIN, { queryGenome })
        assert.fail('expected rejection')
      } catch (err) {
        assert.include(err.message, '1,382,167')
        assert.include(err.message, 'narrow')
      }
    })
  })

  describe('rewriting a small join to {!terms}', () => {
    it('replaces the join with a local terms filter', async () => {
      const queryGenome = stubGenomeQuery(3)
      const result = await resolveJoins(TRAILING_JOIN, { queryGenome })

      assert.isFalse(result.unchanged)
      assert.notInclude(result.query, 'crossCollection')
      assert.include(result.query, '{!terms f=genome_id cache=false}1000.1,1001.1,1002.1')
    })

    it('emits cache=false, which is load-bearing not cosmetic', async () => {
      // A cached terms filter makes Solr materialize the DocSet up front and drive
      // iteration from the scored query: 3,952ms vs 676ms uncached. See CLAUDE.md.
      const result = await resolveJoins(TRAILING_JOIN, { queryGenome: stubGenomeQuery(2) })
      assert.include(result.query, 'cache=false')
    })

    it('rewrites the v= form too', async () => {
      const result = await resolveJoins(V_PARAM_JOIN, { queryGenome: stubGenomeQuery(2) })
      assert.notInclude(result.query, 'crossCollection')
      assert.include(result.query, '{!terms f=genome_id')
    })

    it('preserves the rest of the query untouched', async () => {
      const result = await resolveJoins(V_PARAM_JOIN, { queryGenome: stubGenomeQuery(2) })
      // the co-occurring fq, and the trailing params, must survive
      assert.include(result.query, 'fq=feature_type:(CDS OR mat_peptide)')
      assert.include(result.query, 'rows=0')
    })

    it('targets the join\'s to= field, not always genome_id', async () => {
      const q = '&fq={!join method=crossCollection fromIndex=genome from=genome_id to=gid}genome_status:Complete'
      const result = await resolveJoins(q, { queryGenome: stubGenomeQuery(2) })
      assert.include(result.query, '{!terms f=gid')
    })

    it('reports what it rewrote', async () => {
      const result = await resolveJoins(TRAILING_JOIN, { queryGenome: stubGenomeQuery(5) })
      assert.lengthOf(result.rewrites, 1)
      assert.strictEqual(result.rewrites[0].genomeCount, 5)
      assert.strictEqual(result.rewrites[0].idCount, 5)
    })
  })

  describe('leaving a join alone', () => {
    it('does not rewrite between the rewrite and reject thresholds', async () => {
      // Too big to inline cheaply, not big enough to be dangerous.
      const { rewriteMaxGenomes } = getThresholds()
      const result = await resolveJoins(TRAILING_JOIN, {
        queryGenome: stubGenomeQuery(rewriteMaxGenomes + 1)
      })
      assert.isTrue(result.unchanged)
      assert.include(result.query, 'crossCollection')
    })

    it('leaves a join whose filter matches no genomes', async () => {
      // {!terms} with an empty value list is not valid Solr, and the join over an empty
      // set is already the trivial case.
      const result = await resolveJoins(TRAILING_JOIN, { queryGenome: stubGenomeQuery(0) })
      assert.isTrue(result.unchanged)
      assert.include(result.query, 'crossCollection')
    })

    it('leaves a query with no join entirely alone, without querying Solr', async () => {
      const queryGenome = stubGenomeQuery(5)
      const q = 'q=*:*&rows=10'
      const result = await resolveJoins(q, { queryGenome })
      assert.strictEqual(result.query, q)
      assert.isTrue(result.unchanged)
      assert.lengthOf(queryGenome.calls, 0, 'must not query genome when there is no join')
    })

    it('leaves joins intact when no lookup function is supplied', async () => {
      // Cannot decide without a count; preserving current behavior beats failing.
      const result = await resolveJoins(TRAILING_JOIN, {})
      assert.isTrue(result.unchanged)
      assert.include(result.query, 'crossCollection')
    })
  })

  describe('caching', () => {
    it('reuses a count across calls with the same filter', async () => {
      const queryGenome = stubGenomeQuery(3)
      await resolveJoins(TRAILING_JOIN, { queryGenome })
      const afterFirst = queryGenome.calls.length
      await resolveJoins(TRAILING_JOIN, { queryGenome })
      assert.strictEqual(queryGenome.calls.length, afterFirst,
        'second resolution should be served entirely from cache')
    })

    it('clearCaches forces a fresh lookup', async () => {
      const queryGenome = stubGenomeQuery(3)
      await resolveJoins(TRAILING_JOIN, { queryGenome })
      const afterFirst = queryGenome.calls.length
      clearCaches()
      await resolveJoins(TRAILING_JOIN, { queryGenome })
      assert.isAbove(queryGenome.calls.length, afterFirst)
    })
  })

  describe('failure propagation', () => {
    it('propagates a lookup failure so the caller can decide', async () => {
      // The middleware turns this into fail-open; the library does not decide policy.
      const queryGenome = stubGenomeQuery(3, { fail: true })
      try {
        await resolveJoins(TRAILING_JOIN, { queryGenome })
        assert.fail('expected the lookup error to propagate')
      } catch (err) {
        assert.match(err.message, /solr unavailable/)
      }
    })
  })
})
