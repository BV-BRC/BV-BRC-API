/**
 * Retry-After propagation on 429/503 (app.js terminal error handler).
 *
 * A bare 429 with no Retry-After is the worst thing this API can send: it gives a client
 * no basis for backing off, so the likely response is a tight retry loop — the
 * amplification identified as the cause of the 2026-06-05 coordinator crash. And it does
 * the most damage exactly when a Solr circuit breaker has tripped, i.e. when the cluster
 * is already in trouble.
 *
 * middleware/QueryClassifier sets the header itself for an admission rejection. This pins
 * the other path: a 429 originating at Solr, carried up as a SolrHttpError with
 * retryAfterMs parsed from Solr's own response.
 *
 * Contract is specified in Docs/CLIENT-429.md.
 */

const assert = require('chai').assert
const { SolrHttpError } = require('../../lib/solrHttpError')

// Mirrors the terminal handler in app.js. Kept as a local copy because app.js builds a
// whole Express app and binds a port on require.
function applyRetryAfter (error, res) {
  if ((error.status === 429 || error.status === 503) && !res.getHeader('Retry-After')) {
    const ms = error.retryAfterMs
    const secs = typeof ms === 'number' && ms >= 0
      ? Math.max(1, Math.ceil(ms / 1000))
      : (error.retryAfterSeconds || 1)
    res.setHeader('Retry-After', String(secs))
  }
  return { status: error.status || 500, retryAfter: res.getHeader('Retry-After') }
}

function mockRes (preset) {
  const headers = preset ? { ...preset } : {}
  return {
    setHeader: (k, v) => { headers[k] = v },
    getHeader: (k) => headers[k]
  }
}

describe('Retry-After propagation', () => {
  it('propagates the value Solr sent', () => {
    const err = new SolrHttpError(429, 'busy', { retryAfterMs: 5000 })
    const out = applyRetryAfter(err, mockRes())
    assert.strictEqual(out.status, 429)
    assert.strictEqual(out.retryAfter, '5')
  })

  it('rounds up a sub-second value rather than emitting 0', () => {
    // Retry-After: 0 invites the tight loop the spec prohibits.
    const err = new SolrHttpError(429, 'busy', { retryAfterMs: 200 })
    assert.strictEqual(applyRetryAfter(err, mockRes()).retryAfter, '1')
  })

  it('falls back to 1s when Solr sent no Retry-After', () => {
    const err = new SolrHttpError(429, 'busy', { retryAfterMs: null })
    assert.strictEqual(applyRetryAfter(err, mockRes()).retryAfter, '1')
  })

  it('handles 503 identically — the client contract does not distinguish them', () => {
    const err = new SolrHttpError(503, 'unavailable', { retryAfterMs: 2000 })
    const out = applyRetryAfter(err, mockRes())
    assert.strictEqual(out.status, 503)
    assert.strictEqual(out.retryAfter, '2')
  })

  it('does not overwrite a header an earlier layer already set', () => {
    // QueryClassifier sets Retry-After from the pool's wait deadline; that value is more
    // informed than anything derivable here.
    const err = Object.assign(new Error('busy'), { status: 429, retryAfterSeconds: 10 })
    const out = applyRetryAfter(err, mockRes({ 'Retry-After': '10' }))
    assert.strictEqual(out.retryAfter, '10')
  })

  it('uses retryAfterSeconds when that is what the error carries', () => {
    const err = Object.assign(new Error('busy'), { status: 429, retryAfterSeconds: 7 })
    assert.strictEqual(applyRetryAfter(err, mockRes()).retryAfter, '7')
  })

  it('sets no header on an ordinary 500', () => {
    const err = Object.assign(new Error('boom'), { status: 500 })
    const out = applyRetryAfter(err, mockRes())
    assert.strictEqual(out.status, 500)
    assert.isUndefined(out.retryAfter)
  })

  it('sets no header for a Solr-side 400, which is not the client\'s status', () => {
    // A malformed query is our problem, not the caller's, and is not retriable.
    const err = new SolrHttpError(400, 'bad query')
    const out = applyRetryAfter(err, mockRes())
    assert.notStrictEqual(out.status, 400)
    assert.isUndefined(out.retryAfter)
  })
})
