/**
 * slicedFacet — compute a facet over a genome set too large to join, by slicing.
 *
 * THE PROBLEM
 *
 * `/data/summary_by_taxon/:taxon_id` asks genome_feature for one count per feature_type
 * across every genome in a taxon, via `{!join method=crossCollection fromIndex=genome}`.
 * For taxon 10239 (Viruses, ~14.9M genomes) that join does not finish: observed three
 * times in a 75-minute window at **600 s each, all returning status=500** — roughly 30
 * minutes of coordinator time spent producing nothing. lib/joinResolver.js now refuses it
 * with a fast 400 instead, which is better but still leaves the summary unfillable.
 *
 * THE OBSERVATION THAT MAKES THIS WORK
 *
 * Facet counts are ADDITIVE over disjoint genome slices. Measured directly:
 *
 *     slice 1 (5,000 genomes): {CDS: 18227, mat_peptide: 3053}   284 ms
 *     slice 2 (5,000 genomes): {CDS: 12964, mat_peptide: 2536}   255 ms
 *     summed:                  {CDS: 31191, mat_peptide: 5589}
 *
 * So the join can be replaced by: cursor the genome ids, facet each slice behind a
 * `{!terms}` filter, and sum. Each slice is a sub-second `rows=0` request, so neither
 * SOLR_REQUEST_TIMEOUT_MS nor Cloudflare's ~100 s applies to the whole.
 *
 * AND IT IS CHEAPER, NOT JUST SURVIVABLE. Total Solr work for the same result set
 * (H5N1, 246,835 genomes, measured):
 *
 *     batched, 20,000/slice     ~5.0 s
 *     one 3.1 MB {!terms}        5.1 s
 *     the crossCollection join  52.6 s      <- 10x more
 *
 * Slicing does not add work; the join was the expensive part.
 *
 * WHEN THIS IS VALID — read before reusing it
 *
 * Only for an aggregation that composes by SUMMATION over a partition of the genome set.
 * It holds for `facet.field` counts because the slices are disjoint and exhaustive and
 * every matching document belongs to exactly one slice. It does NOT hold for:
 *
 *   - `unique(...)` / cardinality — a value seen in two slices would be counted twice;
 *   - any facet with `facet.limit` truncation, where a term can fall below the per-slice
 *     cutoff in every slice while being significant overall;
 *   - percentiles, averages, or anything else non-additive.
 *
 * This is unrelated to the "facet counts cannot be corrected inside Solr" note in
 * CLAUDE.md, which is about overlaying different field *values* onto a result set.
 */

const debug = require('debug')('p3api-server:sliced-facet')

const DEFAULT_SLICE = 20000

// 20,000 is not arbitrary. Measured on H5N1, summing Solr QTime across slices:
//    5,000 ids/slice -> ~24.6 s total
//   20,000 ids/slice -> ~5.0 s total
// A 5x penalty for the smaller slice, all of it per-request overhead. Larger slices mean
// larger request bodies, so this trades off eventually, but not before 20,000.

/**
 * Sum one `facet.field` across the genome set matching `genomeFilter`.
 *
 * @param {Object} opts
 * @param {Function} opts.queryGenome  async ({query}) => parsed Solr response
 * @param {Function} opts.queryTarget  async ({query}) => parsed Solr response
 * @param {string}   opts.genomeFilter e.g. 'taxon_lineage_ids:10239'
 * @param {string}   opts.facetField   e.g. 'feature_type'
 * @param {string[]} [opts.extraFq]    other filters, applied to every slice
 * @param {string}   [opts.toField]    target field holding the genome id
 * @param {number}   [opts.sliceSize]
 * @param {number}   [opts.maxSlices]  abandon rather than run unbounded
 * @returns {Promise<{counts: Object, slices: number, genomes: number, truncated: boolean}>}
 */
async function slicedFacetCount (opts = {}) {
  const {
    queryGenome, queryTarget, genomeFilter, facetField,
    extraFq = [], toField = 'genome_id',
    sliceSize = DEFAULT_SLICE, maxSlices = 2000
  } = opts

  if (typeof queryGenome !== 'function' || typeof queryTarget !== 'function') {
    throw new Error('slicedFacetCount requires queryGenome and queryTarget')
  }
  if (!genomeFilter || !facetField) {
    throw new Error('slicedFacetCount requires genomeFilter and facetField')
  }

  const counts = {}
  let cursor = '*'
  let slices = 0
  let genomes = 0
  let truncated = false

  for (;;) {
    const gq = `q=*:*&fq=${encodeURIComponent(genomeFilter)}&fl=genome_id` +
      `&rows=${sliceSize}&sort=genome_id+asc&cursorMark=${encodeURIComponent(cursor)}`
    const gres = await queryGenome({ query: gq })
    const docs = (gres && gres.response && gres.response.docs) || []
    const ids = docs.map((d) => d.genome_id).filter(Boolean)
    const next = gres && gres.nextCursorMark

    if (ids.length) {
      // cache=false: each slice is seen exactly once, so a cached DocSet is pure cost and
      // would evict entries that repeated queries depend on.
      const terms = `{!terms f=${toField} cache=false}${ids.join(',')}`
      let tq = `q=*:*&rows=0&fq=${encodeURIComponent(terms)}` +
        `&facet=true&facet.field=${encodeURIComponent(facetField)}` +
        '&facet.mincount=1&json.nl=map'
      for (const fq of extraFq) {
        tq += `&fq=${encodeURIComponent(fq)}`
      }
      const tres = await queryTarget({ query: tq })
      const ff = tres && tres.facet_counts && tres.facet_counts.facet_fields &&
        tres.facet_counts.facet_fields[facetField]
      // json.nl=map gives an object; without it Solr returns a flat [term, count, …]
      // array. Handle both so a caller that forgets the param gets right answers.
      if (Array.isArray(ff)) {
        for (let i = 0; i < ff.length; i += 2) {
          counts[ff[i]] = (counts[ff[i]] || 0) + ff[i + 1]
        }
      } else if (ff && typeof ff === 'object') {
        for (const k of Object.keys(ff)) {
          counts[k] = (counts[k] || 0) + ff[k]
        }
      }
      slices++
      genomes += ids.length
    }

    if (!docs.length || !next || next === cursor) break
    cursor = next
    if (slices >= maxSlices) {
      // Returning a partial sum silently would be worse than saying so: the caller
      // caches this for a day.
      truncated = true
      debug(`abandoned after ${slices} slices (${genomes} genomes)`)
      break
    }
  }

  debug(`faceted ${facetField} over ${genomes} genomes in ${slices} slices`)
  return { counts, slices, genomes, truncated }
}

module.exports = { slicedFacetCount, DEFAULT_SLICE }
