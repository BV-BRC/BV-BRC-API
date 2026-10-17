/**
 * internalQuery must apply the same SSRF gate the HTTP middleware chain applies.
 *
 * On the HTTP path, `middleware/SolrQuerySanitizer` sits immediately after
 * `RQLQueryParser` — so it screens the *converted* Solr string, not the raw RQL — and
 * hard-rejects any request carrying a dangerous Solr parameter. Its own file header names
 * "TIKI-W094-8: SSRF in multi query endpoint via Solr Injection", and the multi-query
 * endpoint is exactly the first caller moved off HTTP onto `lib/internalQuery`
 * (PLAN_ELIMINATE_SELF_CALL.md step 4). Bypassing HTTP must not bypass the gate.
 *
 * Why the payloads look the way they do: a dangerous parameter cannot be written as a
 * bare RQL term. `shards=http://evil/` dies earlier in RQL parsing as "Unknown converter
 * http" and never reaches the sanitizer, so testing that shape proves nothing. The real
 * vector is smuggling a literal `&` through an RQL *value* as `%26shards%3D…`, which
 * becomes a separate parameter at Solr's decoding layer. All five payloads below were
 * verified against the live HTTP path before the conversion: every one is rejected there
 * with a 400.
 *
 * Runs fully offline. Every assertion here is about a rejection that happens before any
 * Solr client is constructed, so nothing is dialled.
 */
const assert = require('chai').assert
const { internalQuery } = require('../../lib/internalQuery')

// Smuggled-parameter payloads. Each is valid RQL whose converted Solr string decodes to
// contain a prohibited parameter.
const SMUGGLED = {
  'single-encoded shards': 'eq(genome_name,foo%26shards%3Dbar)&select(genome_id)&limit(2)',
  'single-encoded qt': 'eq(genome_name,foo%26qt%3D/x)&select(genome_id)&limit(2)',
  'double-encoded shards': 'eq(genome_name,foo%2526shards%253Dbar)&select(genome_id)&limit(2)',
  'stream.body in a nested term': 'and(eq(genome_id,83332.12),eq(genome_name,x%26stream.body%3Dy))&select(genome_id)&limit(2)',
  'trailing smuggled param': 'eq(genome_name,foo)%26shards%3Dbar&select(genome_id)&limit(2)'
}

async function expectRejection (opts) {
  let caught = null
  try {
    await internalQuery(opts)
  } catch (e) {
    caught = e
  }
  assert.isNotNull(caught, 'internalQuery must reject, not resolve')
  return caught
}

describe('internalQuery - SSRF / Solr parameter injection', function () {
  Object.keys(SMUGGLED).forEach(function (label) {
    it(`rejects a smuggled dangerous parameter (${label})`, async function () {
      const err = await expectRejection({ collection: 'genome', query: SMUGGLED[label] })
      assert.equal(err.statusCode, 400, 'must be classified as a client error, not a 500')
      assert.include(err.message, 'prohibited query parameters')
    })
  })

  it('screens a raw Solr query too, not only the RQL path', async function () {
    // dataRouter (step 5) builds Solr syntax directly, so queryType:'solr' must be gated
    // as well — sanitizing only the RQL branch would leave that caller unprotected.
    const err = await expectRejection({
      collection: 'genome',
      queryType: 'solr',
      query: '&q=*:*&rows=1&shards=http://evil.example.com/solr'
    })
    assert.equal(err.statusCode, 400)
    assert.include(err.message, 'prohibited query parameters')
  })

  it('rejects an unconfigured collection before doing anything else', async function () {
    // The HTTP path gates this at app.js:187 via app.param('dataType'). Callers build the
    // target from client input, so the in-process path has to reinstate it or a query
    // could be aimed at an arbitrary Solr core.
    const err = await expectRejection({ collection: 'not_a_collection', query: 'eq(a,b)' })
    assert.equal(err.statusCode, 404)
  })

  it('classifies malformed RQL as 400 rather than an unclassified failure', async function () {
    const err = await expectRejection({ collection: 'genome', query: 'this is not rql((((' })
    assert.equal(err.statusCode, 400)
  })

  it('classifies an unknown RQL operator as 400', async function () {
    const err = await expectRejection({ collection: 'genome', query: 'bogusop(genome_id,1)' })
    assert.equal(err.statusCode, 400)
  })

  it('does not reject an ordinary query that merely mentions a dangerous word', async function () {
    // A false positive here would silently break real queries. `collection` and `debug`
    // are prohibited *parameter names*; as field values inside an fq they are harmless,
    // and the sanitizer keys on the segment before the first '='.
    //
    // Asserts only that the SSRF/RQL gates pass — the call still fails at the Solr
    // request, which is out of scope for this offline suite.
    let caught = null
    try {
      await internalQuery({ collection: 'genome', query: 'eq(genome_name,debug)&limit(1)', timeout: 1 })
    } catch (e) {
      caught = e
    }
    if (caught) {
      assert.notInclude(caught.message, 'prohibited query parameters',
        'a dangerous word appearing as a field VALUE must not trip the parameter gate')
      assert.notEqual(caught.statusCode, 400)
    }
  })
})
