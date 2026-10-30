/**
 * Unit tests for ShardCursorStream's POST-based shard fetch.
 *
 * Regression coverage for the 8 KB filter ceiling: shard pages used to be GETs
 * with the caller's filter concatenated onto the query string. An RQL
 * terms()/in() clause over a few hundred feature ids crosses Jetty's default
 * requestHeaderSize (8192 bytes), so the shard answered `414 URI Too Long`.
 * That reached the client as HTTP 200 truncated to a single "[", because
 * media/json.js writes the opening bracket before the first document arrives —
 * a mid-stream shard failure can no longer change the status code. Measured
 * ceiling was ~148 feature ids.
 *
 * These tests run fully offline against a local stub standing in for Solr.
 */

const assert = require('chai').assert
const http = require('http')

const ShardCursorStream = require('../../lib/distributed/ShardCursorStream')

describe('ShardCursorStream POST shard fetch', () => {
  let server
  let baseUrl
  let captured

  // Stub Solr: records what it received, answers one page then exhausts the
  // cursor by echoing the same cursorMark back.
  before((done) => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        captured.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
          params: new URLSearchParams(body)
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          response: { numFound: 1, docs: [{ id: 'doc1' }] },
          nextCursorMark: '*' // equals the cursorMark we were sent -> exhausted
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/solr/genome_feature`
      done()
    })
  })

  after((done) => server.close(done))

  beforeEach(() => { captured = [] })

  // Drain a stream built over the stub and return the docs it produced.
  function drain (query, opts = {}) {
    const stream = new ShardCursorStream(Object.assign({
      solrUrl: baseUrl,
      shard: 'shard1',
      query,
      uniqueKey: 'feature_id'
    }, opts))

    return new Promise((resolve, reject) => {
      const docs = []
      stream.on('data', (d) => docs.push(d))
      stream.on('end', () => resolve(docs))
      stream.on('error', reject)
    })
  }

  it('sends POST with the filter in the body, not the URL', async () => {
    await drain('&fq=genome_id:83332.12')

    assert.lengthOf(captured, 1)
    assert.equal(captured[0].method, 'POST')
    assert.equal(captured[0].params.get('fq'), 'genome_id:83332.12')
    // The filter must not be in the request line at all — that is the thing
    // Jetty measures against requestHeaderSize.
    assert.notInclude(captured[0].url, 'genome_id')
  })

  it('carries a terms() filter far larger than Jetty\'s 8192-byte header limit', async () => {
    // 3000 feature ids ~ 55 bytes each: ~165 KB, roughly 20x the old ceiling.
    const ids = []
    for (let i = 0; i < 3000; i++) {
      ids.push(`PATRIC.83332.12.NC_000962.CDS.${i}.${i + 900}.fwd`)
    }
    const filter = `{!terms f=feature_id}${ids.join(',')}`

    await drain('&fq=' + encodeURIComponent(filter))

    const req = captured[0]
    assert.isAbove(Buffer.byteLength(req.body), 8192, 'body should exceed the old ceiling')
    // Request line stays trivially small regardless of filter size.
    assert.isBelow(Buffer.byteLength(req.url), 8192)
    // And the filter arrives byte-identical, local params and all.
    assert.equal(req.params.get('fq'), filter)
  })

  it('preserves repeated fq parameters', async () => {
    await drain('&fq=public:true&fq=annotation:PATRIC')

    const all = captured[0].params.getAll('fq')
    assert.deepEqual(all, ['public:true', 'annotation:PATRIC'])
  })

  it('supplies a default q only when the caller has none', async () => {
    await drain('&fq=public:true')
    assert.deepEqual(captured[0].params.getAll('q'), ['*:*'])
  })

  it('does not emit a duplicate q when the caller supplies one', async () => {
    // RQL-derived constraints may land in q= rather than fq=; adding *:* on top
    // produced two q= parameters and an empty result set.
    await drain('&q=' + encodeURIComponent('feature_type:CDS') + '&fq=public:true')

    assert.deepEqual(captured[0].params.getAll('q'), ['feature_type:CDS'])
  })

  it('round-trips values containing spaces and reserved characters', async () => {
    const filter = '{!terms f=product}alpha beta,gamma+delta,a&b=c'
    await drain('&fq=' + encodeURIComponent(filter))

    assert.equal(captured[0].params.get('fq'), filter)
  })

  it('sends the shared bvbrc User-Agent', async () => {
    await drain('&fq=public:true')

    assert.match(captured[0].headers['user-agent'], /^bvbrc-api\//)
  })

  it('sets a form-encoded content type and an accurate content length', async () => {
    await drain('&fq=public:true')

    const req = captured[0]
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.equal(Number(req.headers['content-length']), Buffer.byteLength(req.body))
  })

  it('still sets the managed cursor parameters', async () => {
    await drain('&fq=public:true', { sort: 'feature_id asc' })

    const p = captured[0].params
    assert.equal(p.get('cursorMark'), '*')
    assert.equal(p.get('shards'), 'shard1')
    assert.equal(p.get('wt'), 'json')
    assert.include(p.get('sort'), 'feature_id')
  })
})
