/**
 * Downloads bypass the join reject; grid pages do not.
 *
 * middleware/JoinResolution sits at routes/dataType.js:263, BEFORE checkIfStreaming, so
 * before this change it refused a bulk download on exactly the same terms as a 25-row
 * grid page — an advanced protein-FASTA download of Viruses 400s in 1.5s.
 *
 * The cap is right for a page and wrong for a download: it protects the single-{!terms}
 * rewrite, whose body grows linearly with the genome count, but a download can resolve
 * in bounded slices instead. See lib/BatchedJoinStream.js for the measurements.
 *
 * What is pinned here is the DECISION, not the streaming (that is covered by
 * test.batched-join-stream.spec.js): who gets the bypass, who still gets the 400, and
 * that the caller's other filters survive into it.
 */

const assert = require('chai').assert
const Config = require('../../config')
const JoinResolution = require('../../middleware/JoinResolution')

const JOIN = '{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:10239'
const QUERY = `q=*:*&fq=${JOIN}&fq=public:true&rows=25&fl=genome_id,patric_id`

function makeReq (over = {}) {
  return Object.assign({
    call_method: 'query',
    call_collection: 'genome_feature',
    call_params: [QUERY],
    requestId: 'test',
    filterParams: {},
    headers: {}
  }, over)
}

function makeRes () {
  const handlers = {}
  return {
    locals: {},
    writableEnded: false,
    once: (ev, fn) => { handlers[ev] = fn },
    _fire: (ev) => handlers[ev] && handlers[ev](),
    _handlers: handlers
  }
}

/** Run the middleware, resolving with whatever it passed to next(). */
function run (req, res) {
  return new Promise((resolve) => {
    const log = console.log
    console.log = () => {}
    JoinResolution(req, res, (err) => {
      console.log = log
      resolve(err)
    })
  })
}

describe('join reject: download bypass', function () {
  let saved

  beforeEach(function () {
    saved = Config.get('joinResolution')
    // Force every join over the limit, and stub the genome count Solr would supply.
    Config.set('joinResolution', Object.assign({}, saved, {
      enabled: true, taxonomicRewrite: false, batchedDownloads: true, rejectMaxGenomes: 1
    }))
    require('../../lib/joinResolver').clearCaches()
  })

  afterEach(function () {
    Config.set('joinResolution', saved)
    require('../../lib/joinResolver').clearCaches()
  })

  // The decision itself, with the genome lookup stubbed. JoinResolution is re-required
  // under a patched module loader so its internalQuery never reaches Solr.
  describe('who gets the bypass', function () {
    let JR

    before(function () {
      const Module = require('module')
      const orig = Module.prototype.require
      Module.prototype.require = function (id) {
        if (id === '../lib/internalQuery') {
          return {
            internalQuery: async ({ query }) => {
              if (/rows=0/.test(query)) return { response: { numFound: 14940584, docs: [] } }
              return { response: { numFound: 0, docs: [] }, nextCursorMark: 'END' }
            }
          }
        }
        return orig.apply(this, arguments)
      }
      delete require.cache[require.resolve('../../middleware/JoinResolution')]
      JR = require('../../middleware/JoinResolution')
      Module.prototype.require = orig
    })

    after(function () {
      delete require.cache[require.resolve('../../middleware/JoinResolution')]
    })

    const exercise = (over) => new Promise((resolve) => {
      const req = makeReq(over)
      const res = makeRes()
      const log = console.log
      console.log = () => {}
      JR(req, res, (err) => {
        console.log = log
        resolve({ err, req, res })
      })
    })

    it('REFUSES a grid page — a page must be fast or fail fast', async function () {
      const { err, req } = await exercise({})
      assert.equal(err && err.status, 400)
      assert.equal(err.errorCode, 'join_too_broad')
      assert.isUndefined(req.skipAPIMethodHandler)
    })

    it('STREAMS an http_download=true request instead of refusing it', async function () {
      const { err, req, res } = await exercise({ isDownload: true })
      assert.isUndefined(err, 'must not refuse a download')
      assert.isTrue(req.skipAPIMethodHandler)
      assert.isOk(res.results && res.results.stream)
      assert.equal(res.locals.batchedJoin.genomeCount, 14940584)
      res.results.stream.destroy()
    })

    it('STREAMS a call_method=stream request', async function () {
      const { err, req, res } = await exercise({ call_method: 'stream' })
      assert.isUndefined(err)
      assert.isTrue(req.skipAPIMethodHandler)
      res.results.stream.destroy()
    })

    it('THREADS the caller\'s sort into the stream', async function () {
      // Without this the stream fetches unsorted, Solr returns internal docid order, and
      // the per-slice rows cap selects a different subset on every run. Measured on alpha
      // 2026-10-28: three runs of one limit(5000) Viruses download returned 5000 records
      // each with ~75% of the ids differing. Asserted on the constructed stream, not on a
      // URLSearchParams re-derivation, because the defect was that the middleware never
      // passed it on -- a parsing test would have passed throughout.
      const q = `q=*:*&fq=${JOIN}&rows=5000&sort=feature_id+asc`
      const { req, res } = await exercise({ isDownload: true, call_params: [q] })
      assert.isTrue(req.skipAPIMethodHandler)
      assert.equal(res.results.stream.sort, 'feature_id asc')
      res.results.stream.destroy()
    })

    it('leaves sort undefined when the caller sent none', async function () {
      const { res } = await exercise({ isDownload: true })
      assert.isUndefined(res.results.stream.sort)
      res.results.stream.destroy()
    })

    it('still refuses a download when batchedDownloads is off', async function () {
      Config.set('joinResolution',
        Object.assign({}, Config.get('joinResolution'), { batchedDownloads: false }))
      const { err, req } = await exercise({ isDownload: true })
      assert.equal(err && err.status, 400)
      assert.isUndefined(req.skipAPIMethodHandler)
    })
  })

  describe('fail-open is preserved', function () {
    it('a Solr lookup failure leaves the join intact and calls next() cleanly', async function () {
      // Offline, internalQuery cannot reach Solr. The middleware must not turn that into
      // a failed request -- the pre-existing behaviour is the safe fallback.
      const req = makeReq()
      const err = await run(req, makeRes())
      assert.isUndefined(err, 'must fail open, not propagate')
      assert.include(req.call_params[0], 'crossCollection', 'join left untouched')
    })
  })

  describe('non-join and non-query requests are untouched', function () {
    it('skips a query carrying no join, without any Solr call', async function () {
      const req = makeReq({ call_params: ['q=*:*&rows=25'] })
      const err = await run(req, makeRes())
      assert.isUndefined(err)
      assert.isUndefined(req.skipAPIMethodHandler)
    })

    it('skips a get', async function () {
      const req = makeReq({ call_method: 'get' })
      const err = await run(req, makeRes())
      assert.isUndefined(err)
    })
  })

  describe('the config gate', function () {
    it('batchedDownloads defaults to OFF', function () {
      Config.set('joinResolution', saved)
      const cfg = Config.get('joinResolution') || {}
      assert.notStrictEqual(cfg.batchedDownloads, true,
        'turning a fast refusal into a long response must be opt-in')
    })
  })

  describe('extracting the caller\'s other filters', function () {
    // The bypass must carry every fq EXCEPT the join, or the download silently returns
    // more rows than the request described -- as a perfectly well-formed file.
    it('separates the join clause from the rest of the query', function () {
      const { findJoins } = require('../../lib/joinResolver')
      const joins = findJoins(QUERY)
      assert.lengthOf(joins, 1)
      const rest = new URLSearchParams(QUERY.replace(joins[0].match, ''))
      assert.deepEqual(rest.getAll('fq'), ['public:true'])
      assert.equal(rest.get('fl'), 'genome_id,patric_id')
      assert.equal(joins[0].filter, 'taxon_lineage_ids:10239')
      assert.equal(joins[0].toField, 'genome_id')
    })

    it('extracts the caller\'s rows= so the walk can stop', function () {
      // The 2026-10-28 live failure: rows was never read, so a limit(100) Bacteria
      // download walked all 264 genome slices and Cloudflare cut it at 125s with zero
      // bytes emitted.
      const q = `q=*:*&fq=${JOIN}&fq=public:true&rows=100&fl=genome_id`
      const { findJoins } = require('../../lib/joinResolver')
      const rest = new URLSearchParams(q.replace(findJoins(q)[0].match, ''))
      assert.equal(parseInt(rest.get('rows'), 10), 100)
    })

    it('finds nothing to strip when there is no join', function () {
      const { findJoins } = require('../../lib/joinResolver')
      assert.lengthOf(findJoins('q=*:*&fq=public:true&rows=25'), 0)
    })
  })
})
