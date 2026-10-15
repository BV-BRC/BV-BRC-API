/**
 * Blocking a client-supplied Solr join (middleware/SolrQuerySanitizer.js).
 *
 * Defense in depth for the OOM class. No join reaches Solr from client input today — the
 * API generates all of them — but a client-submitted crossCollection join over a broad
 * taxon is exactly the shape that crashed three data nodes on 2026-06-25, and nothing
 * structurally prevented one.
 *
 * THE TRAP THIS PINS: SolrQuerySanitizer runs *after* RQLQueryParser, which has already
 * emitted the API's own {!join ...} into call_params for an RQL genome() clause. A naive
 * check of call_params would therefore reject the API's own legitimate joins — turning a
 * defense-in-depth measure into an outage. The "does not block the API's own generated
 * join" case below fails against that mistake.
 *
 * Fully offline.
 */

const assert = require('chai').assert
const SolrQuerySanitizer = require('../../middleware/SolrQuerySanitizer')
const { containsForeignJoin } = SolrQuerySanitizer

// Minimal req/res doubles. The middleware only touches these fields.
function makeReq (overrides = {}) {
  return {
    queryType: 'rql',
    call_params: [''],
    headers: {},
    connection: { remoteAddress: '127.0.0.1' },
    ...overrides
  }
}

function makeRes () {
  const res = { statusCode: null, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

function run (req) {
  const res = makeRes()
  let nextCalled = false
  SolrQuerySanitizer(req, res, () => { nextCalled = true })
  return { res, nextCalled }
}

describe('SolrQuerySanitizer — client-supplied joins', () => {
  describe('containsForeignJoin', () => {
    it('detects a plain join local param', () => {
      assert.isTrue(containsForeignJoin('q=*:*&fq={!join from=a to=b}x:1'))
    })

    it('does NOT flag our own crossCollection-to-genome shape', () => {
      // This is the shape lib/solrjs/rql.js and routes/dataRouter.js generate. It is
      // indistinguishable from a client's copy of it at this point in the chain, and it
      // does not need to be distinguished: JoinResolution counts its genome set
      // downstream and refuses it if it is too broad.
      assert.isFalse(containsForeignJoin(
        'q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:2'))
    })

    it('flags a crossCollection join to a DIFFERENT index', () => {
      assert.isTrue(containsForeignJoin(
        'q=*:*&fq={!join method=crossCollection fromIndex=secrets from=a to=b}x:1'))
    })

    it('detects a percent-encoded join, which would otherwise slip past', () => {
      assert.isTrue(containsForeignJoin('q=*:*&fq=%7B!join%20from=a%20to=b%7Dx:1'))
    })

    it('detects whitespace between the brace and the keyword', () => {
      assert.isTrue(containsForeignJoin('q=*:*&fq={! join from=a}x:1'))
    })

    it('is case-insensitive', () => {
      assert.isTrue(containsForeignJoin('q=*:*&fq={!JOIN from=a}x:1'))
    })

    it('does not fire on ordinary queries', () => {
      assert.isFalse(containsForeignJoin('q=*:*&rows=10'))
      assert.isFalse(containsForeignJoin('keyword(abc)'))
      assert.isFalse(containsForeignJoin('genome(eq(taxon_lineage_ids,2))'))
      assert.isFalse(containsForeignJoin(''))
      assert.isFalse(containsForeignJoin(null))
    })

    it('does not fire on an unrelated local param', () => {
      assert.isFalse(containsForeignJoin('q=*:*&fq={!terms f=genome_id}1.1,2.2'))
    })
  })

  describe('middleware behavior', () => {
    it('blocks a foreign join — a different fromIndex', () => {
      const { res, nextCalled } = run(makeReq({
        queryType: 'solr',
        call_params: ['q=*:*&fq={!join fromIndex=secrets from=a to=b}x:1']
      }))
      assert.strictEqual(res.statusCode, 400)
      assert.isFalse(nextCalled)
      assert.match(res.body.error, /join/i)
    })

    it('THE LIVE REGRESSION: a genome() query sent as solrquery content-type must pass', () => {
      // This exact shape 400'd on alpha for the length of one deploy. The earlier version
      // keyed off `queryType === 'solr'` to decide whether call_params was client-written
      // — but queryType comes from the request's content-type, and the website sends
      // RQL-derived queries as application/solrquery+... too. So every genome() query was
      // rejected as "prohibited join", at any taxon size.
      //
      // The old test suite passed throughout, because it only ever set queryType 'rql'
      // for the generated-join case.
      const { res, nextCalled } = run(makeReq({
        queryType: 'solr',
        call_params: ['&q=*:*&rows=5&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:1929297']
      }))
      assert.isTrue(nextCalled, 'a generated genome() join must not be rejected')
      assert.isNull(res.statusCode)
    })

    it('THE TRAP: does not block the API\'s own generated join', () => {
      // RQLQueryParser has already rewritten call_params into Solr syntax containing
      // {!join ...}. Checking call_params naively would reject this.
      const { res, nextCalled } = run(makeReq({
        queryType: 'rql',
        _originalRql: 'genome(eq(taxon_lineage_ids,1386))&limit(25)',
        call_params: ['&q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:1386&rows=25']
      }))
      assert.isTrue(nextCalled, 'the API\'s own join must pass through')
      assert.isNull(res.statusCode)
    })

    it('blocks a foreign join however the request was labelled', () => {
      // The check reads call_params and keys off the join's own shape, so it does not
      // depend on queryType being accurate — which is what made the earlier version
      // fragile.
      for (const queryType of ['rql', 'solr', undefined]) {
        const { res, nextCalled } = run(makeReq({
          queryType,
          call_params: ['&q=*:*&rows=25&fq={!join from=a to=b}x:1']
        }))
        assert.strictEqual(res.statusCode, 400, `queryType=${queryType}`)
        assert.isFalse(nextCalled)
      }
    })

    it('passes an ordinary Solr request through', () => {
      const { res, nextCalled } = run(makeReq({
        queryType: 'solr',
        call_params: ['q=*:*&fq=genome_id:83332.12&rows=10']
      }))
      assert.isTrue(nextCalled)
      assert.isNull(res.statusCode)
    })

    it('passes an ordinary RQL request through', () => {
      const { res, nextCalled } = run(makeReq({
        queryType: 'rql',
        _originalRql: 'eq(genome_id,83332.12)&limit(10)',
        call_params: ['&q=genome_id:83332.12&rows=10']
      }))
      assert.isTrue(nextCalled)
      assert.isNull(res.statusCode)
    })

    it('still blocks the dangerous params it always did', () => {
      // The pre-existing protection must survive this addition.
      const { res, nextCalled } = run(makeReq({
        queryType: 'solr',
        call_params: ['q=*:*&shards=http://evil.example.com/solr']
      }))
      assert.strictEqual(res.statusCode, 400)
      assert.isFalse(nextCalled)
    })
  })
})
