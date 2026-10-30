/**
 * `http_filter_cache` — the caller's paging-intent hint.
 *
 * Two halves, both offline:
 *   1. http-params.js captures http_filter_* into req.filterParams and STRIPS it, so the
 *      hint never reaches Solr (it is not a Solr parameter; Solr would reject it).
 *   2. JoinResolution.resolveFilterCacheHint turns it, or its absence, into a boolean.
 *
 * Rationale and the measurements behind the default are in
 * Docs/PROPOSAL-http-filter-cache-hint.md.
 */

const assert = require('chai').assert
const httpParams = require('../../middleware/http-params')
const { resolveFilterCacheHint } = require('../../middleware/JoinResolution')

function runParams (url) {
  const req = { url, headers: {} }
  httpParams(req, {}, () => {})
  return req
}

describe('http_filter_cache', function () {
  describe('http-params capture', function () {
    it('captures the hint into req.filterParams', function () {
      const req = runParams('/genome_sequence/?eq(genome_id,*)&http_filter_cache=true')
      assert.equal(req.filterParams.http_filter_cache, 'true')
    })

    it('STRIPS it from the query so it never reaches Solr', function () {
      // Solr rejects unknown local params on some paths and silently ignores them on
      // others; either way an API-level hint has no business being forwarded.
      const req = runParams('/genome_sequence/?eq(genome_id,*)&http_filter_cache=false')
      assert.notInclude(req.url, 'http_filter_cache')
    })

    it('does not become a header — it is a hint, not a header', function () {
      // http_accept/http_range DO become headers, via an allowlist. http_filter_* must
      // not, which is why it is captured before that branch is reached.
      const req = runParams('/genome_sequence/?http_filter_cache=true')
      assert.isUndefined(req.headers.filter)
      assert.isUndefined(req.headers.cache)
    })

    it('leaves filterParams an empty object when absent', function () {
      const req = runParams('/genome_sequence/?eq(genome_id,*)')
      assert.deepEqual(req.filterParams, {})
    })

    it('does not disturb the sibling http_source_* capture', function () {
      const req = runParams('/genome_feature/?http_source_collection=sp_gene&http_filter_cache=true')
      assert.equal(req.sourceParams.http_source_collection, 'sp_gene')
      assert.equal(req.filterParams.http_filter_cache, 'true')
    })
  })

  describe('resolveFilterCacheHint', function () {
    const req = (over = {}) => Object.assign(
      { filterParams: {}, call_params: ['q=*:*&rows=25'], call_method: 'query' }, over)

    it('honours an explicit true', function () {
      assert.isTrue(resolveFilterCacheHint(req({ filterParams: { http_filter_cache: 'true' } })))
      assert.isTrue(resolveFilterCacheHint(req({ filterParams: { http_filter_cache: '1' } })))
    })

    it('honours an explicit false, even on a shape that would otherwise cache', function () {
      const r = req({ filterParams: { http_filter_cache: 'false' }, isDownload: true })
      assert.isFalse(resolveFilterCacheHint(r))
    })

    it('treats auto, and anything unrecognised, as "infer"', function () {
      assert.isTrue(resolveFilterCacheHint(req({ filterParams: { http_filter_cache: 'auto' } })))
      assert.isTrue(resolveFilterCacheHint(req({ filterParams: { http_filter_cache: 'banana' } })))
    })

    it('infers cached for a download — _streamQuery cursors by construction', function () {
      assert.isTrue(resolveFilterCacheHint(req({ isDownload: true })))
      assert.isTrue(resolveFilterCacheHint(req({ call_method: 'stream' })))
    })

    it('infers UNcached for rows=0, the facet-count shape', function () {
      // summary_by_taxon: rows=0 plus facets. It cannot page, so a cached DocSet is
      // pure cost.
      assert.isFalse(resolveFilterCacheHint(req({ call_params: ['q=*:*&rows=0&facet=true'] })))
    })

    it('infers UNcached for rows=1, a probe', function () {
      assert.isFalse(resolveFilterCacheHint(req({ call_params: ['q=*:*&rows=1'] })))
    })

    it('DEFAULTS TO CACHED for an ordinary grid page', function () {
      // The load-bearing default. A grid's first page is indistinguishable from a
      // one-shot, and the mistakes are asymmetric: caching a one-shot pays one DocSet
      // build, while not caching a paged query rebuilds on every page (measured
      // 1,017 vs 786 ms/page under cursorMark).
      assert.isTrue(resolveFilterCacheHint(req({ call_params: ['q=*:*&rows=25&start=0'] })))
    })

    it('survives a missing filterParams or call_params', function () {
      assert.isTrue(resolveFilterCacheHint({}))
      assert.isTrue(resolveFilterCacheHint({ filterParams: {} }))
    })

    it('does not mistake rows=10 or rows=100 for rows=1 or rows=0', function () {
      // The rows= patterns are anchored to a following & or end-of-string precisely so
      // that rows=10 does not read as rows=1.
      assert.isTrue(resolveFilterCacheHint(req({ call_params: ['q=*:*&rows=10&start=0'] })))
      assert.isTrue(resolveFilterCacheHint(req({ call_params: ['q=*:*&rows=100'] })))
    })
  })
})
