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
const { containsJoinLocalParam } = SolrQuerySanitizer

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
  describe('containsJoinLocalParam', () => {
    it('detects a plain join local param', () => {
      assert.isTrue(containsJoinLocalParam('q=*:*&fq={!join from=a to=b}x:1'))
    })

    it('detects a crossCollection join', () => {
      assert.isTrue(containsJoinLocalParam(
        'q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:2'))
    })

    it('detects a percent-encoded join, which would otherwise slip past', () => {
      assert.isTrue(containsJoinLocalParam('q=*:*&fq=%7B!join%20from=a%20to=b%7Dx:1'))
    })

    it('detects whitespace between the brace and the keyword', () => {
      assert.isTrue(containsJoinLocalParam('q=*:*&fq={! join from=a}x:1'))
    })

    it('is case-insensitive', () => {
      assert.isTrue(containsJoinLocalParam('q=*:*&fq={!JOIN from=a}x:1'))
    })

    it('does not fire on ordinary queries', () => {
      assert.isFalse(containsJoinLocalParam('q=*:*&rows=10'))
      assert.isFalse(containsJoinLocalParam('keyword(abc)'))
      assert.isFalse(containsJoinLocalParam('genome(eq(taxon_lineage_ids,2))'))
      assert.isFalse(containsJoinLocalParam(''))
      assert.isFalse(containsJoinLocalParam(null))
    })

    it('does not fire on an unrelated local param', () => {
      assert.isFalse(containsJoinLocalParam('q=*:*&fq={!terms f=genome_id}1.1,2.2'))
    })
  })

  describe('middleware behavior', () => {
    it('blocks a Solr-format request carrying its own join', () => {
      const { res, nextCalled } = run(makeReq({
        queryType: 'solr',
        call_params: ['q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:2']
      }))
      assert.strictEqual(res.statusCode, 400)
      assert.isFalse(nextCalled)
      assert.match(res.body.error, /join/i)
    })

    it('THE TRAP: does not block the API\'s own generated join', () => {
      // RQLQueryParser has already rewritten call_params into Solr syntax containing
      // {!join ...}. Checking call_params for an RQL request would reject this.
      const { res, nextCalled } = run(makeReq({
        queryType: 'rql',
        _originalRql: 'genome(eq(taxon_lineage_ids,1386))&limit(25)',
        call_params: ['&q=*:*&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:1386&rows=25']
      }))
      assert.isTrue(nextCalled, 'the API\'s own join must pass through')
      assert.isNull(res.statusCode)
    })

    it('blocks a join smuggled through RQL as raw text', () => {
      const { res, nextCalled } = run(makeReq({
        queryType: 'rql',
        _originalRql: 'q=*:*&fq={!join from=a to=b}x:1',
        call_params: ['&q=*:*&rows=25']
      }))
      assert.strictEqual(res.statusCode, 400)
      assert.isFalse(nextCalled)
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
