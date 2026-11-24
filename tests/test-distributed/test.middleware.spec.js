/**
 * Unit tests for DistributedQuery middleware
 */

const assert = require('chai').assert
const {
  shouldUseDistributedQuery,
  parseLimit,
  parseSort,
  parseFields,
  stripManagedParams
} = require('../../middleware/DistributedQuery')

describe('DistributedQuery Middleware', function () {
  describe('parseLimit()', function () {
    it('should parse rows parameter', function () {
      // Note: regex matches rows at start, or after & or ?
      assert.equal(parseLimit('q=*:*&rows=100'), 100)
      assert.equal(parseLimit('&rows=50000'), 50000)
      assert.equal(parseLimit('fq=genome_id:123&rows=25'), 25)
      assert.equal(parseLimit('rows=500'), 500) // rows at start
    })

    it('should return 0 when no rows parameter', function () {
      assert.equal(parseLimit('q=*:*'), 0)
      assert.equal(parseLimit(''), 0)
      assert.equal(parseLimit('fq=genome_id:123'), 0)
    })

    it('should handle rows at start of query', function () {
      assert.equal(parseLimit('?rows=100'), 100)
      assert.equal(parseLimit('rows=200'), 200)
    })
  })

  describe('parseSort()', function () {
    it('should parse sort parameter', function () {
      // URL encoding: + is decoded to space, %20 is also space
      assert.equal(parseSort('q=*:*&sort=feature_id%20asc'), 'feature_id asc')
      assert.equal(parseSort('&sort=genome_id%20desc'), 'genome_id desc')
      assert.equal(parseSort('sort=id+asc'), 'id asc') // sort at start
    })

    it('should return null when no sort parameter', function () {
      assert.isNull(parseSort('q=*:*'))
      assert.isNull(parseSort(''))
    })

    it('should decode URL-encoded sort', function () {
      assert.equal(parseSort('&sort=feature_id%20asc'), 'feature_id asc')
    })

    it('should handle plus signs in sort (URL space encoding)', function () {
      // + in URLs represents a space in query strings
      // Our parser should decode + as space
      assert.equal(parseSort('&sort=feature_id+asc'), 'feature_id asc')
    })
  })

  describe('parseFields()', function () {
    it('should parse fl parameter', function () {
      assert.equal(parseFields('q=*:*&fl=feature_id,genome_id'), 'feature_id,genome_id')
      assert.equal(parseFields('fl=id,name'), 'id,name') // fl at start
    })

    it('should return null when no fl parameter', function () {
      assert.isNull(parseFields('q=*:*'))
      assert.isNull(parseFields(''))
    })
  })

  describe('stripManagedParams()', function () {
    it('should strip rows, sort, fl parameters but convert q to fq', function () {
      const query = 'q=genome_id:123&rows=10000&sort=feature_id+asc&fl=patric_id,product&fq=public:true'
      const stripped = stripManagedParams(query)
      // q=genome_id:123 should become fq=genome_id:123
      assert.equal(stripped, '&fq=genome_id:123&fq=public:true')
    })

    it('should preserve multiple fq parameters', function () {
      const query = 'q=*:*&fq=annotation:PATRIC&fq=public:true&rows=50000'
      const stripped = stripManagedParams(query)
      // q=*:* is dropped (default), only fq params kept
      assert.equal(stripped, '&fq=annotation:PATRIC&fq=public:true')
    })

    it('should convert non-default q to fq', function () {
      const query = 'q=genome_id:562.*&fq=annotation:PATRIC&rows=100'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '&fq=genome_id:562.*&fq=annotation:PATRIC')
    })

    it('should handle query starting with ?', function () {
      const query = '?q=test:value&fq=genome_id:123&rows=100'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '&fq=test:value&fq=genome_id:123')
    })

    it('should handle query starting with &', function () {
      const query = '&q=test:value&fq=genome_id:123&rows=100'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '&fq=test:value&fq=genome_id:123')
    })

    it('should return empty string when no non-managed params', function () {
      const query = 'q=*:*&rows=100&sort=id+asc&fl=id,name'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '')
    })

    it('should strip distributed param', function () {
      const query = 'q=*:*&fq=genome_id:123&distributed=true&rows=100'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '&fq=genome_id:123')
    })

    it('should preserve unknown parameters', function () {
      const query = 'q=*:*&customParam=value&fq=test:1&rows=100'
      const stripped = stripManagedParams(query)
      assert.equal(stripped, '&customParam=value&fq=test:1')
    })
  })

  describe('shouldUseDistributedQuery()', function () {
    const baseConfig = {
      enabled: true,
      minLimitThreshold: 10000,
      enabledCollections: ['genome_feature'],
      disabledCollections: [],
      exposeMetadataHeaders: true
    }

    function createMockReq (overrides = {}) {
      return {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['q=*:*&rows=50000'],
        headers: {},
        ...overrides
      }
    }

    it('should return false when globally disabled', function () {
      const config = { ...baseConfig, enabled: false }
      const req = createMockReq()

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.equal(result.reason, 'disabled globally')
    })

    it('should reject facet queries (cannot stream facet_counts)', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&facet=true&facet.field=host_name']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'facet/group')
    })

    it('should reject grouped queries (cannot stream grouped response)', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&group=true&group.field=genome_id']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'facet/group')
    })

    it('should reject facet queries even with distributed=true override', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&facet=true&distributed=true']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'facet/group')
    })

    describe('an unresolved crossCollection join never reaches the shards', function () {
      // stripManagedParams keeps every fq, so a surviving {!join method=crossCollection}
      // is sent to each shard intact and every one builds the join DocSet independently:
      // the broad-taxon cold build that OOMed data nodes and that Cloudflare cuts at
      // 125s. Measured on alpha 2026-10-29, identical protein-FASTA download of taxon
      // 10239 -- distributed 524 after 125s, standard 200 with 3.05 MB in 5.7s.
      //
      // JoinResolution normally removes the clause. This is the backstop for when it
      // does not, which today means its fail-open path (a Solr blip during the genome
      // lookup leaves the join intact and calls next()).
      const JOIN = '{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:10239'

      it('refuses a query still carrying the join clause', function () {
        const req = createMockReq({ call_params: [`q=*:*&fq=${JOIN}&rows=50000`] })
        const result = shouldUseDistributedQuery(req, baseConfig)
        assert.isFalse(result.useDistributed)
        assert.include(result.reason, 'crossCollection')
      })

      it('refuses it even with an explicit distributed=true override', function () {
        // The override must not be able to resurrect the OOM shape.
        const req = createMockReq({ call_params: [`q=*:*&fq=${JOIN}&rows=50000&distributed=true`] })
        const result = shouldUseDistributedQuery(req, baseConfig)
        assert.isFalse(result.useDistributed)
        assert.include(result.reason, 'crossCollection')
      })

      it('refuses it even with the X-Distributed-Query header', function () {
        const req = createMockReq({
          call_params: [`q=*:*&fq=${JOIN}&rows=50000`],
          headers: { 'x-distributed-query': 'true' }
        })
        const result = shouldUseDistributedQuery(req, baseConfig)
        assert.isFalse(result.useDistributed)
        assert.include(result.reason, 'crossCollection')
      })

      it('still allows a join that JoinResolution already rewrote to {!terms}', function () {
        // The rewrite is the normal case for a taxon under rejectMaxGenomes, and it is
        // fine distributed -- verified live: small-taxon join, 200 with 3.65 MB. This
        // guard must not cost us that path.
        const req = createMockReq({
          call_params: ['q=*:*&fq={!terms f=genome_id cache=false}1386.1,1386.2&rows=50000']
        })
        const result = shouldUseDistributedQuery(req, baseConfig)
        assert.isTrue(result.useDistributed)
      })

      it('leaves an ordinary join-free query alone', function () {
        // Control for the guard itself: no join, same shape, must still go distributed.
        // Verified live byte-identical on both paths (4,214,626 B).
        const req = createMockReq({ call_params: ['q=*:*&fq=annotation:"PATRIC"&rows=50000'] })
        const result = shouldUseDistributedQuery(req, baseConfig)
        assert.isTrue(result.useDistributed)
      })
    })

    it('should not misfire on fields that merely contain "facet"', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&fl=facet_note,genome_id']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
    })

    it('should respect X-Distributed-Query header override (enabled)', function () {
      // Note: header override takes precedence over enabled flag
      const config = { ...baseConfig, enabled: true }
      const req = createMockReq({
        headers: { 'x-distributed-query': 'true' }
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      assert.include(result.reason, 'header override')
    })

    it('should respect X-Distributed-Query header override (disabled)', function () {
      const config = baseConfig
      const req = createMockReq({
        headers: { 'x-distributed-query': 'false' }
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'header override')
    })

    it('should respect distributed query param override', function () {
      // Note: query param override takes precedence but only after enabled check
      const config = { ...baseConfig, enabled: true }
      const req = createMockReq({
        call_params: ['q=*:*&rows=50000&distributed=true']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      // When enabled and param says true, it uses param
    })

    it('should reject non-query methods', function () {
      const config = baseConfig
      const req = createMockReq({ call_method: 'get' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'method get not supported')
    })

    it('should allow stream method', function () {
      const config = baseConfig
      const req = createMockReq({ call_method: 'stream' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
    })

    it('should reject collections not in enabledCollections', function () {
      const config = baseConfig
      const req = createMockReq({ call_collection: 'taxonomy' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'not in enabledCollections')
    })

    it('should reject collections in disabledCollections', function () {
      const config = {
        ...baseConfig,
        enabledCollections: [],
        disabledCollections: ['genome_feature']
      }
      const req = createMockReq()

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'in disabledCollections')
    })

    it('should reject queries below threshold', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=1000']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isFalse(result.useDistributed)
      assert.include(result.reason, 'below threshold')
    })

    it('should accept queries at or above threshold', function () {
      const config = baseConfig
      const req = createMockReq({
        call_params: ['q=*:*&rows=10000']
      })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
      assert.include(result.reason, '>= threshold')
    })

    it('should accept all collections when enabledCollections is empty', function () {
      const config = {
        ...baseConfig,
        enabledCollections: []
      }
      const req = createMockReq({ call_collection: 'any_collection' })

      const result = shouldUseDistributedQuery(req, config)

      assert.isTrue(result.useDistributed)
    })
  })

  describe('a stream attached upstream is left alone', function () {
    /**
     * The middleware used to do `res.results = wrapForMediaHandler(...)`
     * unconditionally, discarding whatever an earlier middleware had attached.
     *
     * That is how an over-broad join download died: JoinResolution answers one by
     * attaching a BatchedJoinStream rather than by rewriting the query, so
     * req.call_params[0] still carried the raw {!join method=crossCollection} clause,
     * and stripManagedParams keeps every fq -- the untouched join went to every shard.
     * Measured on alpha: 524 after 125s with zero bytes, against 200 with 3.05 MB in
     * 5.7s on the standard path for the same request.
     *
     * These run the REAL middleware against a STUBBED DistributedQueryManager that
     * succeeds. That stub is the whole point: offline, the real manager cannot reach
     * Solr and throws before the overwrite at `res.results = wrapForMediaHandler(...)`
     * is ever reached, so the sentinel survives and the test passes against the
     * UNFIXED middleware -- proving nothing. With a manager that succeeds, removing
     * the guard replaces res.results and these fail, which is the point of a gate.
     */
    const JOIN = '{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:10239'

    // getManager() does its require INSIDE the async body, so it resolves at call time
    // and a module-loader patch in before() is long gone by then. Cache the singleton it
    // would build instead -- same seam, and it survives because getManager returns early
    // when `distributedQueryManager` is already set.
    const DistributedQuery = require('../../middleware/DistributedQuery')
    const DQManager = require('../../lib/distributed/DistributedQueryManager')

    let savedExecute

    before(function () {
      savedExecute = DQManager.prototype.executeQuery
      DQManager.prototype.executeQuery = async function () {
        return {
          stream: { __fromDistributed: true, on () {}, pipe () {} },
          metadata: {
            streamType: 'stub',
            parallelism: 1,
            shardCount: 1,
            totalFound: 0,
            prewarmElapsedMs: null
          }
        }
      }
    })

    after(function () {
      DQManager.prototype.executeQuery = savedExecute
    })

    const sentinel = () => ({ stream: { __sentinel: true } })

    const run = (req, res) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('middleware never called next()')), 4000)
      DistributedQuery(req, res, (err) => { clearTimeout(t); resolve(err) })
    })

    it('does not overwrite res.results when skipAPIMethodHandler is set', async function () {
      const res = { results: sentinel(), set: () => {}, on: () => {} }
      const err = await run({
        call_method: 'stream',
        call_collection: 'genome_feature',
        call_params: [`q=*:*&fq=${JOIN}&rows=50000&sort=feature_id asc`],
        skipAPIMethodHandler: true,
        headers: {}
      }, res)
      assert.isUndefined(err)
      assert.isTrue(res.results.stream.__sentinel, 'the attached stream must survive')
    })

    it('does not overwrite an attached stream even without the flag', async function () {
      const res = { results: sentinel(), set: () => {}, on: () => {} }
      const err = await run({
        call_method: 'stream',
        call_collection: 'genome_feature',
        call_params: [`q=*:*&fq=${JOIN}&rows=50000&sort=feature_id asc`],
        headers: {}
      }, res)
      assert.isUndefined(err)
      assert.isTrue(res.results.stream.__sentinel)
    })

    it('ignores a distributed=true override rather than reclaiming the request', async function () {
      // A caller asking for the distributed path does not override the fact that this
      // request has already been answered by someone else.
      const res = { results: sentinel(), set: () => {}, on: () => {} }
      const err = await run({
        call_method: 'stream',
        call_collection: 'genome_feature',
        call_params: ['q=*:*&rows=50000&distributed=true'],
        skipAPIMethodHandler: true,
        headers: { 'x-distributed-query': 'true' }
      }, res)
      assert.isUndefined(err)
      assert.isTrue(res.results.stream.__sentinel)
    })

    it('still claims a normal request with no stream attached', async function () {
      // Control, and it is load-bearing: the guard must not short-circuit everything.
      // With the stub manager succeeding, a request carrying no join and no attached
      // stream must still come out of the middleware owned by the distributed path.
      const res = { results: undefined, set: () => {}, on: () => {} }
      const req = {
        call_method: 'query',
        call_collection: 'genome_feature',
        call_params: ['q=*:*&fq=annotation:"PATRIC"&rows=50000&sort=feature_id asc'],
        headers: {}
      }
      const err = await run(req, res)
      assert.isUndefined(err)
      // Assert on OWNERSHIP, not on the stub's marker: wrapForMediaHandler pipes the
      // manager's stream through a PassThrough, so __fromDistributed is not on the
      // outer object. What matters is that the middleware replaced res.results and
      // claimed the request.
      assert.isOk(res.results && res.results.stream, 'must attach its own stream')
      assert.isNotTrue(res.results.stream.__sentinel, 'must not be the untouched sentinel')
      assert.isTrue(req.skipAPIMethodHandler, 'must claim the request')
    })
  })
})
