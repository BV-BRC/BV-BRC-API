/**
 * Regression: `and()`/`or()` must not emit a literal `q=()`
 *
 * When every child of an and()/or() is consumed into a non-`q` part of the Solr
 * query — genome() becomes an `fq`, select() becomes `fl`, limit() becomes
 * `rows` — the group serialized to the string "()", which is truthy, so
 * toSolr's `if (!sq) sq = '*:*'` guard never fired. Solr then rejected the
 * request with:
 *
 *   HTTP 400  "Cannot parse '()': Encountered \")\" at line 1, column 1"
 *
 * This bit the all-rows cross-collection download whose source query from a
 * taxon view is exactly `genome(and(...))&select(...)&limit(...)`. The website
 * carries a client-side workaround for it (DownloadExecutor.js buildQuery
 * prepends `eq(<pk>,*)`); with this fixed at the source, that workaround is
 * belt-and-braces rather than load-bearing.
 */

const assert = require('chai').assert
const Rql = require('../../lib/solrjs/rql')
const Expander = require('../../ExpandingQuery')

const OPTS = { maxRequestLimit: 999999999, defaultLimit: 25, collection: 'genome_feature' }

async function toSolr (rql) {
  const resolved = await Expander.ResolveQuery(rql, { req: {}, res: {} })
  return Rql(resolved).toSolr(OPTS)
}

function qOf (solrQuery) {
  const m = solrQuery.match(/&q=([^&]*)/)
  return m ? m[1] : null
}

describe('rql toSolr — empty group guard', function () {
  describe('queries that previously produced q=()', function () {
    it('genome() with select()', async function () {
      const q = qOf(await toSolr('genome(eq(genome_id,999001.1))&select(feature_id)'))
      assert.notEqual(q, '()')
      assert.equal(q, '*:*')
    })

    it('genome() with limit()', async function () {
      const q = qOf(await toSolr('genome(eq(genome_id,999001.1))&limit(5)'))
      assert.equal(q, '*:*')
    })

    it('the real taxon-view cross-collection source query', async function () {
      const solr = await toSolr(
        'genome(and(eq(taxon_lineage_ids,114185),ne(genome_status,Deprecated)))' +
        '&select(feature_id)&limit(2500000)')
      assert.equal(qOf(solr), '*:*')
      // The genome predicate must still be present as a join fq — the guard
      // must not have swallowed the filter along with the empty group.
      assert.include(solr, 'fromIndex=genome')
      assert.include(solr, 'taxon_lineage_ids:114185')
    })
  })

  describe('unchanged behavior', function () {
    it('bare genome() (already worked)', async function () {
      assert.equal(qOf(await toSolr('genome(eq(genome_id,999001.1))')), '*:*')
    })

    it('the client-side workaround shape still works', async function () {
      const q = qOf(await toSolr(
        'and(eq(feature_id,*),genome(eq(genome_id,999001.1)))&select(feature_id)&limit(5)'))
      assert.equal(q, 'feature_id:*')
    })

    it('a plain term query is untouched', async function () {
      assert.equal(qOf(await toSolr('eq(feature_id,f.pub.1)&select(feature_id)&limit(5)')), 'feature_id:f.pub.1')
    })

    it('a real and() of two terms still ANDs', async function () {
      assert.equal(qOf(await toSolr('and(eq(a,1),eq(b,2))&select(x)')), '(a:1 AND b:2)')
    })

    it('a real or() of two terms still ORs', async function () {
      assert.equal(qOf(await toSolr('or(eq(a,1),eq(b,2))&limit(3)')), '(a:1 OR b:2)')
    })

    it('select()/limit() still become fl/rows, not part of q', async function () {
      const solr = await toSolr('eq(a,1)&select(x,y)&limit(7)')
      assert.include(solr, '&fl=x,y')
      assert.include(solr, '&rows=7')
      assert.equal(qOf(solr), 'a:1')
    })
  })
})
