/**
 * multiQuery sub-query error propagation and in-process dispatch.
 *
 * Guards the fix for a silent-200 bug: `util/http.js`'s `httpRequest` discards
 * `res.statusCode` and resolves the response body regardless, so multiQuery used to
 * `JSON.parse` a 500's error body straight into the caller's result slot, producing
 *
 *   { "query1": { "result": { "status": 500, "message": "A Database Error Occured" } } }
 *
 * inside an outer HTTP 200. The website rendered an empty panel with no sign of failure.
 *
 * The load-bearing assertion is still the negative one — that a failed sub-query does NOT
 * get an array-shaped `result`. Asserting only on the presence of `error` would still pass
 * if the old parse-into-result behavior came back alongside it.
 *
 * This suite used to stand up a stub of the inner `/:dataType/` endpoint and point the
 * router at it via `http_port`, because multiQuery reached its own listening port over
 * HTTP. That self-call is gone (PLAN_ELIMINATE_SELF_CALL.md step 4), so the seam moved:
 * `lib/internalQuery` is stubbed in `require.cache` before the router is loaded. The stub
 * also records its arguments, which lets the suite pin the two things that are easy to get
 * silently wrong in the conversion — the 25000 row cap and identity forwarding.
 *
 * Still no live API, Solr, or Redis: stubbing the module means it is never evaluated, and
 * the real ExpandingQuery makes no outbound call for RQL with no expandable terms.
 */
const assert = require('chai').assert
const express = require('express')
const http = require('http')

describe('multiQuery - sub-query error propagation', function () {
  let outerServer, outerPort, calls, behavior, internalQueryPath

  before(function (done) {
    calls = []
    // Per-collection stub behavior, reset by each test that needs something specific.
    behavior = {}

    internalQueryPath = require.resolve('../../lib/internalQuery')

    function fakeInternalQuery (opts) {
      calls.push(opts)
      const fn = behavior[opts.collection]
      if (!fn) {
        const err = new Error(`Unknown collection: ${opts.collection}`)
        err.statusCode = 404
        return Promise.reject(err)
      }
      return fn(opts)
    }

    // Install before requiring the router: multiQuery destructures `internalQuery` at
    // module load, so patching the real module's exports afterwards would not be seen.
    require.cache[internalQueryPath] = {
      id: internalQueryPath,
      filename: internalQueryPath,
      loaded: true,
      exports: { internalQuery: fakeInternalQuery, internalQueryDocs: () => Promise.resolve([]) }
    }

    delete require.cache[require.resolve('../../routes/multiQuery')]
    const Router = require('../../routes/multiQuery')

    const app = express()
    // app.js sets requestId globally before mounting /query; mirror that so the router
    // has the same fields it does in production.
    app.use(function (req, res, next) { req.requestId = 'test-rid'; next() })
    app.use('/query', Router)
    outerServer = app.listen(0, '127.0.0.1', () => {
      outerPort = outerServer.address().port
      done()
    })
  })

  after(function () {
    if (outerServer) outerServer.close()
    delete require.cache[internalQueryPath]
    delete require.cache[require.resolve('../../routes/multiQuery')]
  })

  beforeEach(function () {
    calls = []
    behavior = {
      genome: () => Promise.resolve({
        response: { numFound: 1, docs: [{ genome_id: '83332.12', genome_name: 'Mycobacterium tuberculosis H37Rv' }] }
      }),
      genome_feature: () => {
        const err = new Error('A Database Error Occured')
        err.statusCode = 500
        return Promise.reject(err)
      },
      // No statusCode: an unclassified failure must still be reported, not swallowed.
      pathway: () => Promise.reject(new Error('socket hang up'))
    }
  })

  function postMulti (payloadObj) {
    const payload = JSON.stringify(payloadObj)
    return new Promise((resolve, reject) => {
      const req = http.request({
        port: outerPort,
        method: 'POST',
        path: '/query/',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(body) })
          } catch (e) {
            reject(new Error(`unparsable outer response: ${body}`))
          }
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('returns rows for a sub-query that succeeds', async function () {
    const { body } = await postMulti({
      ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)' }
    })
    assert.isArray(body.ok.result)
    assert.lengthOf(body.ok.result, 1)
    assert.equal(body.ok.result[0].genome_id, '83332.12')
    assert.isUndefined(body.ok.error)
  })

  it('reports an error instead of storing the error body as the result', async function () {
    const { body } = await postMulti({
      failing: { dataType: 'genome_feature', query: 'eq(genome_id,83332.12)' }
    })

    // The regression guard: the old code put {status,message} here.
    assert.isUndefined(body.failing.result,
      'a failed sub-query must not produce a `result` (this was the silent-200 bug)')

    assert.isString(body.failing.error)
    assert.include(body.failing.error, 'HTTP 500')
    assert.include(body.failing.error, 'A Database Error Occured',
      'the upstream message should be surfaced, not swallowed')
    assert.equal(body.failing.status, 500)
  })

  it('defaults an unclassified failure to 500 rather than dropping the status', async function () {
    const { body } = await postMulti({
      hangup: { dataType: 'pathway', query: 'eq(genome_id,83332.12)' }
    })
    assert.isUndefined(body.hangup.result)
    assert.include(body.hangup.error, 'HTTP 500')
    assert.include(body.hangup.error, 'socket hang up')
    assert.equal(body.hangup.status, 500)
  })

  it('reports an unknown collection as 404', async function () {
    const { body } = await postMulti({
      bad: { dataType: 'not_a_collection', query: 'eq(a,b)' }
    })
    assert.isUndefined(body.bad.result)
    assert.include(body.bad.error, 'HTTP 404')
    assert.equal(body.bad.status, 404)
  })

  it('rejects malformed RQL as 400', async function () {
    // ExpandingQuery.ResolveQuery throws SYNCHRONOUSLY here (Query() is called before any
    // promise exists), so this also guards against the try/catch being replaced by a bare
    // .catch(), which would let the throw escape as an unhandled 500.
    const { body } = await postMulti({
      bad: { dataType: 'genome', query: 'this is not rql((((' }
    })
    assert.isUndefined(body.bad.result)
    assert.equal(body.bad.status, 400)
    assert.lengthOf(calls, 0, 'a query that cannot be parsed must never reach Solr')
  })

  it('caps sub-queries at the 25000-row HTTP limit, not internalQuery default of 50000', async function () {
    // RQLQueryParser.js:106 uses 25000 for non-downloads; internalQuery defaults to
    // MAX_LIMIT (50000). Passing the default would silently double the ceiling.
    await postMulti({ ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)&limit(30000)' } })
    assert.lengthOf(calls, 1)
    assert.equal(calls[0].maxLimit, 25000)
  })

  it('forwards the caller identity and request id to the sub-query', async function () {
    await postMulti({ ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)' } })
    assert.lengthOf(calls, 1)
    // Anonymous here (no token in this offline suite), but the key must be present and
    // sourced from req.user — an omitted `user` would make every sub-query anonymous even
    // for an authenticated caller, silently hiding their private rows.
    assert.property(calls[0], 'user')
    assert.equal(calls[0].requestId, 'test-rid')
  })

  it('returns the whole Solr response for application/solr+json', async function () {
    const { body } = await postMulti({
      s: { dataType: 'genome', query: 'eq(genome_id,83332.12)', accept: 'application/solr+json' }
    })
    assert.isObject(body.s.result)
    assert.property(body.s.result, 'response')
    assert.equal(body.s.result.response.numFound, 1)
  })

  it('returns grouped output when the query grouped instead of returning docs', async function () {
    behavior.genome = () => Promise.resolve({ grouped: { genus: { matches: 3, groups: [] } } })
    const { body } = await postMulti({
      g: { dataType: 'genome', query: 'eq(genome_id,83332.12)' }
    })
    assert.isObject(body.g.result)
    assert.property(body.g.result, 'genus')
  })

  it('does not let one failing sub-query take down the others', async function () {
    // Promise.all would reject the whole batch on the first failure, which would be a
    // worse regression than the bug being fixed. Each label must settle independently.
    const { statusCode, body } = await postMulti({
      ok: { dataType: 'genome', query: 'eq(genome_id,83332.12)' },
      failing: { dataType: 'genome_feature', query: 'eq(genome_id,83332.12)' },
      html: { dataType: 'pathway', query: 'eq(genome_id,83332.12)' }
    })

    assert.equal(statusCode, 200)
    assert.isArray(body.ok.result, 'the healthy panel still returns its rows')
    assert.lengthOf(body.ok.result, 1)
    assert.isUndefined(body.failing.result)
    assert.isString(body.failing.error)
    assert.isUndefined(body.html.result)
    assert.isString(body.html.error)
  })
})
