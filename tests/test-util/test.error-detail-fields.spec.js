/**
 * Structured error detail on the JSON body.
 *
 * The terminal handler in app.js used to send exactly `{status, message}`. A client that
 * wanted to react to a rejection — rather than just print the sentence — had to regex
 * English prose for the numbers, which breaks the moment anyone rewords it.
 *
 * So the handler now also copies an ALLOWLIST of fields, plus a stable `error` tag. Two
 * properties are pinned here, and they pull in opposite directions:
 *
 *   1. the additions are ADDITIVE — `message` is untouched, so existing clients that
 *      display it see no change at all;
 *   2. only allowlisted fields are copied — an Error carries stacks, Solr fragments and
 *      the caller's own filter, and blanket-serialising that is a disclosure bug.
 *
 * This exercises the handler's logic directly rather than booting the app, which needs
 * Solr and Redis.
 */

const assert = require('chai').assert
const { JoinTooBroadError } = require('../../lib/joinResolver')

// Mirrors app.js's terminal handler. Kept in step with it by the "matches app.js" test
// below, which reads the real source.
const ERROR_DETAIL_FIELDS = ['genomeCount', 'limit', 'taxonId']

function renderBody (error) {
  const body = {
    status: error.status || 500,
    message: error.message || 'Interal Server Error'
  }
  if (error.errorCode) body.error = error.errorCode
  for (const f of ERROR_DETAIL_FIELDS) {
    if (error[f] !== undefined) body[f] = error[f]
  }
  return body
}

describe('structured error detail', function () {
  describe('JoinTooBroadError', function () {
    const err = () => new JoinTooBroadError(
      'This query matches 14,940,584 genomes, which is too many to process (limit 150,000). ' +
      'Please narrow the filter — for example, choose a more specific taxon.',
      {
        genomeCount: 14940584,
        limit: 150000,
        filter: 'taxon_lineage_ids:10239 AND !genome_status:Deprecated',
        taxonId: '10239'
      })

    it('carries a stable machine-readable code', function () {
      // Clients branch on this. The prose is for humans and may be reworded freely.
      assert.equal(err().errorCode, 'join_too_broad')
      assert.equal(renderBody(err()).error, 'join_too_broad')
    })

    it('publishes the numbers a UI needs to say something useful', function () {
      const b = renderBody(err())
      assert.equal(b.genomeCount, 14940584)
      assert.equal(b.limit, 150000)
      assert.equal(b.taxonId, '10239')
    })

    it('KEEPS the English message verbatim', function () {
      // The whole point of adding fields rather than replacing the body: a client that
      // only knows how to print `message` must be unaffected.
      const b = renderBody(err())
      assert.include(b.message, '14,940,584 genomes')
      assert.include(b.message, 'choose a more specific taxon')
      assert.equal(b.status, 400)
    })

    it('does NOT leak the raw Solr filter', function () {
      // `filter` is on the error for logging. It is raw Solr the client never wrote, and
      // echoing query internals back is the habit that produces disclosure bugs.
      const b = renderBody(err())
      assert.notProperty(b, 'filter')
      assert.notInclude(JSON.stringify(b), 'genome_status')
    })

    it('omits taxonId when the filter was not taxonomic', function () {
      // e.g. genome_status:Complete — over the limit, but no taxon to offer children for.
      const e = new JoinTooBroadError('too many', { genomeCount: 9000000, limit: 150000 })
      const b = renderBody(e)
      assert.notProperty(b, 'taxonId')
      assert.equal(b.genomeCount, 9000000)
    })
  })

  describe('the allowlist', function () {
    it('copies nothing that is not listed', function () {
      const e = new Error('boom')
      e.status = 500
      e.stack = 'Error: boom\n    at secret.js:1:1'
      e.solrResponse = { internal: 'detail' }
      e.password = 'hunter2'
      const b = renderBody(e)
      assert.deepEqual(Object.keys(b).sort(), ['message', 'status'])
    })

    it('leaves an ordinary error exactly as it was before this change', function () {
      const e = new Error('Unable to request the database.')
      e.status = 500
      assert.deepEqual(renderBody(e),
        { status: 500, message: 'Unable to request the database.' })
    })

    it('still defaults a status-less error to 500', function () {
      assert.equal(renderBody(new Error('x')).status, 500)
    })

    it('matches the allowlist actually compiled into app.js', function () {
      // The renderBody above is a copy. If app.js's list changes and this one does not,
      // every assertion here silently stops describing production.
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../app.js'), 'utf8')
      const m = src.match(/const ERROR_DETAIL_FIELDS = \[([^\]]*)\]/)
      assert.isNotNull(m, 'ERROR_DETAIL_FIELDS must exist in app.js')
      const actual = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
      assert.deepEqual(actual, ERROR_DETAIL_FIELDS)
    })
  })
})
