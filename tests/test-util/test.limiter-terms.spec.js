/**
 * Limiter must cap `rows` for a terms() id list the same way it does for in().
 *
 * Not a cosmetic symmetry. `rows` is what DistributedQuery tests against
 * minLimitThreshold (10000), so while only in() was detected, a client sending
 * the usual limit(25000) got:
 *
 *   in(pk,(...100 ids))     -> rows capped to 110    -> standard path
 *   terms(pk,(...100 ids))  -> rows stays at 25000   -> distributed path
 *
 * The two operators then ran on different transports, which is how an external
 * benchmark measured terms() as ~2.3x slower at n=100 with the gap closing as n
 * rose — the distributed path's fixed setup cost amortizing, not anything about
 * the operator.
 *
 * Offline — the middleware is called directly with a stub req/res.
 */

const assert = require('chai').assert
const Limiter = require('../../middleware/Limiter')

const ID_COUNT_BUFFER = 10

// Run the middleware over a Solr query string and hand back the rewritten one.
function limit (solrQuery, collection, extra) {
  const req = Object.assign({
    call_method: 'query',
    call_collection: collection,
    call_params: [solrQuery],
    requestId: 'test',
    headers: {}
  }, extra)

  let called = false
  const log = console.log
  console.log = () => {}
  try {
    Limiter(req, {}, () => { called = true })
  } finally {
    console.log = log
  }

  assert.isTrue(called, 'Limiter must call next()')
  return req.call_params[0]
}

const rowsOf = (q) => Number((q.match(/&rows=(\d+)/) || [])[1])

// The two operators as lib/solrjs/rql.js actually emits them.
const inQuery = (n) => {
  const ids = Array.from({ length: n }, (_, i) => `f${i}`)
  return `&q=(feature_id:(${ids.join(' OR ')}))&rows=25000&fl=feature_id`
}
const termsQuery = (n, localParams) => {
  const ids = Array.from({ length: n }, (_, i) => `f${i}`)
  const lp = localParams === undefined ? 'f=feature_id cache=false' : localParams
  return `&q=*:*&rows=25000&fl=feature_id&fq={!terms ${lp}}${ids.join(',')}`
}

describe('Limiter fixed-ID detection', () => {
  it('caps rows for a terms() list, as it already did for in()', () => {
    assert.equal(rowsOf(limit(termsQuery(100), 'genome_feature')), 110)
  })

  it('gives in() and terms() the same rows for the same id list', () => {
    for (const n of [2, 100, 1500, 9000]) {
      assert.equal(
        rowsOf(limit(termsQuery(n), 'genome_feature')),
        rowsOf(limit(inQuery(n), 'genome_feature')),
        `id count ${n}`
      )
    }
  })

  it('drops a small terms() query below minLimitThreshold, as in() already was', () => {
    // The actual point of the change: 110 < 10000, so DistributedQuery declines
    // it and both operators take the standard path.
    assert.isBelow(rowsOf(limit(termsQuery(100), 'genome_feature')), 10000)
  })

  it('only ever caps downward, never raises the client\'s rows', () => {
    // 3 ids + buffer = 13, below the requested 25, so it still tightens; what it
    // must not do is push rows up toward idCount + buffer.
    const terms = rowsOf(limit('&q=*:*&rows=25&fq={!terms f=feature_id cache=false}a,b,c', 'genome_feature'))
    const bool = rowsOf(limit('&q=(feature_id:(a OR b OR c))&rows=25', 'genome_feature'))
    assert.isAtMost(terms, 25)
    assert.equal(terms, bool)
  })

  it('recognizes the filter without the cache directive', () => {
    // rql.js emits cache=false now, but other callers and older captured
    // queries do not; the detection must not depend on it.
    assert.equal(rowsOf(limit(termsQuery(50, 'f=feature_id'), 'genome_feature')), 60)
  })

  it('matches each collection against its own primary key only', () => {
    // genome_id is genome's primary key, not genome_feature's, so the same
    // filter caps on one collection and not the other.
    const q = '&q=*:*&rows=25000&fq={!terms f=genome_id cache=false}1.1,2.2,3.3'
    assert.equal(rowsOf(limit(q, 'genome')), 3 + ID_COUNT_BUFFER)
    assert.equal(rowsOf(limit(q, 'genome_feature')), 25000)
  })

  it('does not match a field that merely starts with a primary key', () => {
    const q = '&q=*:*&rows=25000&fq={!terms f=genome_id_x cache=false}a,b,c'
    assert.equal(rowsOf(limit(q, 'genome')), 25000)
  })

  it('takes the largest count when several id lists are present', () => {
    const q = '&q=(feature_id:(a OR b))&rows=25000&fq={!terms f=feature_id cache=false}' +
      Array.from({ length: 40 }, (_, i) => `f${i}`).join(',')
    assert.equal(rowsOf(limit(q, 'genome_feature')), 50)
  })

  it('stops at the fq boundary rather than swallowing later params', () => {
    // &appRid= is appended after this point in real requests, and other &-params
    // can already follow the fq. Counting past the boundary would inflate rows.
    const q = '&q=*:*&rows=25000&fq={!terms f=feature_id cache=false}a,b,c&sort=feature_id+asc&fl=a,b,c,d,e'
    assert.equal(rowsOf(limit(q, 'genome_feature')), 3 + ID_COUNT_BUFFER)
  })

  it('ignores a filter carrying a separator local param instead of miscounting', () => {
    // Comma counting is wrong when the value delimiter is not a comma. Nothing
    // emits one; skipping leaves rows uncapped, which is the safe direction.
    const q = '&q=*:*&rows=25000&fq={!terms f=feature_id separator=";"}a;b;c'
    assert.equal(rowsOf(limit(q, 'genome_feature')), 25000)
  })

  it('leaves a single-value terms() filter uncapped', () => {
    // Matches the existing in() behaviour (maxIdCount > 1), and a lone value is
    // already a get-by-id in practice.
    assert.equal(rowsOf(limit('&q=*:*&rows=25000&fq={!terms f=feature_id cache=false}only', 'genome_feature')), 25000)
  })

  it('ignores a {!terms} clause that is not an fq', () => {
    // Only an fq is unconditionally ANDed, so only there does the value count
    // bound the result set.
    const q = '&q={!terms f=feature_id}a,b,c&rows=25000'
    assert.equal(rowsOf(limit(q, 'genome_feature')), 25000)
  })

  it('leaves collections with no configured primary key alone', () => {
    const q = '&q=*:*&rows=25000&fq={!terms f=id cache=false}a,b,c'
    assert.equal(rowsOf(limit(q, 'genome_amr')), 25000)
  })
})
