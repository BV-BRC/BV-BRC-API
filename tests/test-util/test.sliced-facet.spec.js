/**
 * slicedFacetCount — summing a facet over genome slices too numerous to join.
 *
 * Offline; both Solr calls are stubs. The arithmetic claim this rests on was verified
 * against live Solr and is recorded in the module header:
 *
 *   slice 1 (5,000 genomes): {CDS: 18227, mat_peptide: 3053}
 *   slice 2 (5,000 genomes): {CDS: 12964, mat_peptide: 2536}
 *   summed:                  {CDS: 31191, mat_peptide: 5589}
 *
 * The cases that matter are the ones where being wrong is SILENT: a dropped slice
 * undercounts, a repeated cursor double-counts, and a partial sum cached for a day is
 * worse than no answer at all.
 */

const assert = require('chai').assert
const { slicedFacetCount } = require('../../lib/slicedFacet')

/**
 * Stub `total` genome ids, cursor-paged, where each slice reports `perSlice` facet
 * counts. Records every query for inspection.
 */
function stubs ({ total = 10, perSlice = { CDS: 100, mat_peptide: 10 }, asArray = false } = {}) {
  const calls = { genome: [], target: [] }
  let served = 0
  return {
    calls,
    queryGenome: async ({ query }) => {
      calls.genome.push(query)
      const rows = parseInt(/rows=(\d+)/.exec(query)[1], 10)
      const n = Math.min(rows, Math.max(0, total - served))
      const docs = Array.from({ length: n }, (_, i) => ({ genome_id: `g${served + i}` }))
      served += n
      return {
        response: { numFound: total, docs },
        nextCursorMark: served >= total ? 'END' : `c${served}`
      }
    },
    queryTarget: async ({ query }) => {
      calls.target.push(query)
      const ff = asArray
        ? Object.entries(perSlice).flat()
        : Object.assign({}, perSlice)
      return { facet_counts: { facet_fields: { feature_type: ff } } }
    }
  }
}

const base = (s, over = {}) => Object.assign({
  queryGenome: s.queryGenome,
  queryTarget: s.queryTarget,
  genomeFilter: 'taxon_lineage_ids:10239',
  facetField: 'feature_type'
}, over)

describe('slicedFacetCount', function () {
  it('SUMS facet counts across slices', async function () {
    const s = stubs({ total: 25, perSlice: { CDS: 100, mat_peptide: 10 } })
    const out = await slicedFacetCount(base(s, { sliceSize: 10 }))
    // 25 genomes in slices of 10 -> 3 slices
    assert.equal(out.slices, 3)
    assert.equal(out.genomes, 25)
    assert.deepEqual(out.counts, { CDS: 300, mat_peptide: 30 })
  })

  it('handles Solr\'s flat [term, count, …] array as well as json.nl=map', async function () {
    // A caller that forgets json.nl=map must still get right answers, not zeros.
    const s = stubs({ total: 20, perSlice: { CDS: 7 }, asArray: true })
    const out = await slicedFacetCount(base(s, { sliceSize: 10 }))
    assert.deepEqual(out.counts, { CDS: 14 })
  })

  it('visits every genome exactly once — no slice dropped or repeated', async function () {
    // A dropped slice undercounts and a repeated one double-counts, both silently.
    const s = stubs({ total: 97, perSlice: { CDS: 1 } })
    const out = await slicedFacetCount(base(s, { sliceSize: 10 }))
    assert.equal(out.genomes, 97)
    assert.equal(out.counts.CDS, out.slices)
  })

  it('carries extraFq into every slice', async function () {
    const s = stubs({ total: 15 })
    await slicedFacetCount(base(s, {
      sliceSize: 5, extraFq: ['feature_type:(CDS OR mat_peptide)']
    }))
    assert.isAbove(s.calls.target.length, 1)
    for (const q of s.calls.target) {
      assert.include(decodeURIComponent(q), 'feature_type:(CDS OR mat_peptide)')
    }
  })

  it('uses cache=false and rows=0 on every slice', async function () {
    // rows=0 because only the facet is wanted; cache=false because a slice is seen once.
    const s = stubs({ total: 5 })
    await slicedFacetCount(base(s))
    const q = decodeURIComponent(s.calls.target[0])
    assert.include(q, 'cache=false')
    assert.include(s.calls.target[0], 'rows=0')
  })

  it('reports truncated rather than returning a partial sum', async function () {
    // The caller caches this for a day. A quietly-partial number would be worse than
    // no number, so the flag exists for the caller to refuse it.
    const s = stubs({ total: 1000, perSlice: { CDS: 1 } })
    const out = await slicedFacetCount(base(s, { sliceSize: 10, maxSlices: 3 }))
    assert.isTrue(out.truncated)
    assert.equal(out.slices, 3)
  })

  it('is not truncated on a normal run', async function () {
    const s = stubs({ total: 30 })
    const out = await slicedFacetCount(base(s, { sliceSize: 10 }))
    assert.isFalse(out.truncated)
  })

  it('returns empty counts for an empty genome set, without touching the target', async function () {
    const s = stubs({ total: 0 })
    const out = await slicedFacetCount(base(s))
    assert.deepEqual(out.counts, {})
    assert.equal(out.slices, 0)
    assert.lengthOf(s.calls.target, 0)
  })

  it('targets the supplied field, not always genome_id', async function () {
    const s = stubs({ total: 5 })
    await slicedFacetCount(base(s, { toField: 'gid' }))
    assert.include(decodeURIComponent(s.calls.target[0]), '{!terms f=gid')
  })

  it('rejects a call missing its lookups or its filter', async function () {
    const s = stubs({ total: 5 })
    const bad = [
      [{ queryTarget: s.queryTarget, genomeFilter: 'x:1', facetField: 'f' }, 'queryGenome'],
      [{ queryGenome: s.queryGenome, queryTarget: s.queryTarget, facetField: 'f' }, 'genomeFilter'],
      [{ queryGenome: s.queryGenome, queryTarget: s.queryTarget, genomeFilter: 'x:1' }, 'facetField']
    ]
    for (const [opts, missing] of bad) {
      try {
        await slicedFacetCount(opts)
        assert.fail(`expected a throw for missing ${missing}`)
      } catch (e) {
        assert.match(e.message, /requires/)
      }
    }
  })

  it('propagates a target failure instead of returning a short count', async function () {
    const s = stubs({ total: 50 })
    let n = 0
    const flaky = async (a) => {
      if (++n === 2) throw new Error('solr exploded')
      return s.queryTarget(a)
    }
    try {
      await slicedFacetCount(base(s, { queryTarget: flaky, sliceSize: 10 }))
      assert.fail('expected the failure to propagate')
    } catch (e) {
      assert.include(e.message, 'solr exploded')
    }
  })
})
