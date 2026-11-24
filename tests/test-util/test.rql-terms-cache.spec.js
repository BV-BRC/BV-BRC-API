/**
 * Regression: `terms()` must emit `cache=false`, and must not swallow the
 * clauses it shares a query with.
 *
 * `terms()` moves its id list out of `q=` and into an `fq=`. That is where its
 * speed comes from — an unscored filter instead of a scored boolean — but it
 * also means any *other* clause in the query is left behind as the whole of the
 * scored query. With the filter cached, Solr materializes its DocSet up front
 * and then drives iteration from that scored query, so:
 *
 *   in(feature_type,(mat_peptide,CDS)) & terms(feature_id,(6000 ids))
 *
 * scores ~the entire genome_feature core and filters afterwards, where the
 * all-in() form gives Solr one boolean query it can lead with the selective id
 * clause. Measured on the production cluster at 6000 ids, rows held constant
 * (min-of-2 QTime): both-in() 2418 ms, cached terms 3952 ms, terms with
 * cache=false 676 ms. Uncached, the terms query is an ordinary scorer in the
 * intersection and leads it.
 *
 * Two P3DataAPI call sites send exactly this shape
 * (retrieve_protein_feature_sequence and retrieve_nucleotide_feature_sequence
 * both carry in(feature_type,...)), which is how it was found.
 *
 * Offline — string emission only, no Solr.
 */

const assert = require('chai').assert
const Rql = require('../../lib/solrjs/rql')

const OPTS = { maxRequestLimit: 25000, defaultLimit: 25, collection: 'genome_feature' }

const toSolr = (rql) => Rql(rql).toSolr(OPTS)

// The `q=` portion, i.e. everything before the first subsequent &param.
function qOf (solrQuery) {
  const m = solrQuery.match(/^&q=([^&]*)/)
  return m ? m[1] : null
}

function fqsOf (solrQuery) {
  return (solrQuery.match(/&fq=[^&]*/g) || []).map(s => s.slice(4))
}

describe('RQL terms() filter emission', () => {
  it('marks the filter cache=false', () => {
    const solr = toSolr('terms(feature_id,(F1,F2,F3))&select(feature_id)')

    assert.include(fqsOf(solr), '{!terms f=feature_id cache=false}F1,F2,F3')
  })

  it('does not cache one-shot id lists into Solr\'s filterCache', () => {
    // The precise thing the old emission got wrong: a bare {!terms f=...} with
    // no cache directive, which Solr caches by default.
    const solr = toSolr('terms(md5,(a,b,c))')

    assert.notMatch(solr, /\{!terms f=md5\}/, 'must not emit an implicitly-cached terms filter')
  })

  it('leaves a co-occurring clause in q= (so cache=false is load-bearing)', () => {
    // This asserts the shape that makes cache=false matter, so that if someone
    // later changes terms() to also relocate the sibling clause, the test that
    // justifies cache=false fails loudly rather than silently going stale.
    const solr = toSolr('in(feature_type,(mat_peptide,CDS))&terms(feature_id,(F1,F2))&select(feature_id)')

    assert.equal(qOf(solr), '(feature_type:(mat_peptide OR CDS))')
    assert.include(fqsOf(solr), '{!terms f=feature_id cache=false}F1,F2')
  })

  it('emits q=*:* when terms() is the only clause', () => {
    const solr = toSolr('terms(feature_id,(F1,F2))')

    assert.equal(qOf(solr), '*:*')
  })

  it('emits one cache=false filter per terms() clause', () => {
    const solr = toSolr('terms(feature_id,(F1,F2))&terms(genome_id,(G1,G2))')

    assert.deepEqual(fqsOf(solr), [
      '{!terms f=feature_id cache=false}F1,F2',
      '{!terms f=genome_id cache=false}G1,G2'
    ])
  })

  it('leaves in() alone — it stays a boolean in q=', () => {
    // in() is not being changed; it has no fq to mark. Pinned so the two
    // operators do not drift into each other.
    const solr = toSolr('in(feature_id,(F1,F2))&select(feature_id)')

    assert.equal(qOf(solr), '(feature_id:(F1 OR F2))')
    assert.deepEqual(fqsOf(solr), [])
  })
})
