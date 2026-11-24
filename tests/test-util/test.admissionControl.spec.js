/**
 * Admission control (lib/SolrAdmissionControl.js, middleware/QueryClassifier.js).
 *
 * Layer 1 of PLAN_SOLR_OVERLOAD_PROTECTION.md: bound how many amplifying requests run at
 * once. The serializer caps bound fan-out per request; nothing bounded the number of
 * concurrent requests, which is what saturated the shard hosts in the June 2026 scraping
 * incidents.
 *
 * These pin the four properties that matter more than the pool sizes (see the header of
 * lib/SolrAdmissionControl.js):
 *
 *   1. bounded depth AND a wait deadline
 *   2. the wait measured from ARRIVAL, not from dequeue
 *   3. queued entries whose client disconnected are dropped
 *   4. everything counted, for /stats
 *
 * Fully offline.
 */

const assert = require('chai').assert
const { Pool, AdmissionRejectedError } = require('../../lib/SolrAdmissionControl')
const QueryClassifier = require('../../middleware/QueryClassifier')

const { classify } = QueryClassifier

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('SolrAdmissionControl', () => {
  describe('basic admission', () => {
    it('admits immediately while slots are free', async () => {
      const pool = new Pool('t', { maxConcurrent: 2, maxQueue: 2, maxWaitMs: 1000 })
      const r1 = await pool.acquire()
      const r2 = await pool.acquire()
      assert.strictEqual(pool.active, 2)
      assert.strictEqual(pool.depth, 0)
      r1(); r2()
      assert.strictEqual(pool.active, 0)
    })

    it('queues once the pool is full, rather than rejecting', async () => {
      // The core of the design decision: a brief wait beats a rejection the client must
      // redo. See the "no queuing" discussion in the status doc.
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 2, maxWaitMs: 2000 })
      const r1 = await pool.acquire()

      let admitted = false
      const p2 = pool.acquire().then((rel) => { admitted = true; return rel })

      await sleep(20)
      assert.isFalse(admitted, 'should be waiting, not admitted')
      assert.strictEqual(pool.depth, 1)

      r1()
      const r2 = await p2
      assert.isTrue(admitted, 'should be admitted once a slot frees')
      r2()
    })

    it('releases are idempotent, so a double release cannot admit a phantom', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 1, maxWaitMs: 500 })
      const rel = await pool.acquire()
      rel(); rel(); rel()
      assert.strictEqual(pool.active, 0, 'active must not go negative')
    })

    it('serves waiters FIFO', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 3, maxWaitMs: 2000 })
      const r1 = await pool.acquire()
      const order = []
      const a = pool.acquire().then((r) => { order.push('a'); return r })
      await sleep(5)
      const b = pool.acquire().then((r) => { order.push('b'); return r })
      await sleep(5)

      r1()
      ;(await a)()
      ;(await b)()
      assert.deepStrictEqual(order, ['a', 'b'])
    })
  })

  describe('property 1 — bounded depth AND a wait deadline', () => {
    it('rejects with 429 when the queue is full', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 1, maxWaitMs: 5000 })
      const r1 = await pool.acquire()
      const queued = pool.acquire() // fills the queue

      try {
        await pool.acquire() // one too many
        assert.fail('expected rejection')
      } catch (err) {
        assert.instanceOf(err, AdmissionRejectedError)
        assert.strictEqual(err.status, 429, 'app.js reads .status')
        assert.strictEqual(err.statusCode, 429)
        assert.strictEqual(err.reason, 'queue_full')
        assert.isAtLeast(err.retryAfterSeconds, 1, 'Retry-After of 0 invites a tight retry loop')
      }

      r1()
      ;(await queued)()
    })

    it('rejects with 429 when the wait deadline passes', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 5, maxWaitMs: 60 })
      const r1 = await pool.acquire() // never released during the test

      try {
        await pool.acquire()
        assert.fail('expected a wait timeout')
      } catch (err) {
        assert.instanceOf(err, AdmissionRejectedError)
        assert.strictEqual(err.reason, 'wait_timeout')
      }
      assert.strictEqual(pool.depth, 0, 'the timed-out waiter must leave the queue')
      r1()
    })

    it('a depth cap alone would not save it — both bounds are enforced', async () => {
      // Depth 5 is never exceeded here; the deadline is what sheds load.
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 5, maxWaitMs: 50 })
      const r1 = await pool.acquire()
      const results = await Promise.allSettled([pool.acquire(), pool.acquire()])
      assert.isTrue(results.every((r) => r.status === 'rejected'))
      assert.isTrue(results.every((r) => r.reason.reason === 'wait_timeout'))
      r1()
    })
  })

  describe('property 2 — the wait runs from arrival, not from dequeue', () => {
    it('THE REGRESSION: time already spent queued counts toward the deadline', async function () {
      // This is the req.setTimeout mistake one layer up. If the deadline restarted when a
      // waiter reached the head of the queue, total wait would be unbounded with enough
      // churn ahead of it. Here the second waiter spends its whole life behind the first
      // and must still be refused on schedule.
      this.timeout(5000)

      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 5, maxWaitMs: 150 })
      const held = await pool.acquire() // held for the whole test

      const t0 = Date.now()
      const settled = await Promise.allSettled([pool.acquire(), pool.acquire()])
      const elapsed = Date.now() - t0

      assert.isTrue(settled.every((s) => s.status === 'rejected'))
      // Both arrived together, so both deadlines expire together — roughly maxWaitMs,
      // not a multiple of it.
      assert.isBelow(elapsed, 600, `both should expire near 150ms; took ${elapsed}ms`)
      held()
    })
  })

  describe('property 3 — abandoned waiters are dropped', () => {
    it('does not spend a slot on a client that has disconnected', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 3, maxWaitMs: 2000 })
      const r1 = await pool.acquire()

      let gone = false
      const abandoned = pool.acquire({ isAbandoned: () => gone })
      await sleep(10)
      const live = pool.acquire({ isAbandoned: () => false })
      await sleep(10)

      gone = true // the first waiter's client closes the tab
      r1()

      const settled = await Promise.allSettled([abandoned, live])
      assert.strictEqual(settled[0].status, 'rejected')
      assert.strictEqual(settled[0].reason.reason, 'abandoned')
      assert.strictEqual(settled[1].status, 'fulfilled', 'the live waiter still gets the slot')
      assert.strictEqual(pool.abandonedTotal, 1)
      settled[1].value()
    })

    it('a throwing isAbandoned predicate does not drop a live request', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 2, maxWaitMs: 1000 })
      const r1 = await pool.acquire()
      const p = pool.acquire({ isAbandoned: () => { throw new Error('boom') } })
      r1()
      const rel = await p // must be admitted, not dropped
      assert.isFunction(rel)
      rel()
    })
  })

  describe('property 4 — counters for /stats', () => {
    it('counts admissions, queueing, and both rejection reasons', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 1, maxWaitMs: 50 })

      const r1 = await pool.acquire() // admitted
      const timedOut = pool.acquire() // queued, will time out
      let full
      try {
        await pool.acquire() // queue full
      } catch (err) { full = err }

      await Promise.allSettled([timedOut])

      const s = pool.stats()
      assert.strictEqual(s.admitted_total, 1)
      assert.strictEqual(s.queued_total, 1)
      assert.strictEqual(s.rejected_queue_full_total, 1)
      assert.strictEqual(s.rejected_timeout_total, 1)
      assert.strictEqual(full.reason, 'queue_full')
      r1()
    })

    it('reports depth and oldest_wait_ms while requests are waiting', async () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 3, maxWaitMs: 3000 })
      const r1 = await pool.acquire()
      const w = pool.acquire()
      await sleep(60)

      const s = pool.stats()
      assert.strictEqual(s.depth, 1)
      assert.isAtLeast(s.oldest_wait_ms, 40, 'oldest_wait_ms should reflect real waiting')

      r1()
      ;(await w)()
      assert.strictEqual(pool.stats().oldest_wait_ms, 0, 'zero when the queue is empty')
    })

    it('produces JSON-serializable stats', () => {
      const pool = new Pool('t', { maxConcurrent: 1, maxQueue: 1, maxWaitMs: 100 })
      assert.doesNotThrow(() => JSON.stringify(pool.stats()))
    })
  })
})

describe('QueryClassifier', () => {
  it('classifies a download as heavy', () => {
    assert.strictEqual(classify({ isDownload: true, call_params: ['&rows=25'] }), 'heavy')
  })

  it('classifies a stream as heavy', () => {
    assert.strictEqual(classify({ call_method: 'stream', call_params: ['&rows=25'] }), 'heavy')
  })

  it('classifies a large rows= as heavy', () => {
    assert.strictEqual(classify({ call_params: ['&q=*:*&rows=25000'] }), 'heavy')
    assert.strictEqual(classify({ call_params: ['&q=*:*&rows=10000'] }), 'heavy')
  })

  it('classifies an ordinary grid page as interactive', () => {
    assert.strictEqual(classify({ call_params: ['&q=*:*&rows=25'] }), 'interactive')
    assert.strictEqual(classify({ call_params: ['&q=*:*&rows=9999'] }), 'interactive')
  })

  it('classifies a query with no rows= as interactive', () => {
    assert.strictEqual(classify({ call_params: ['&q=*:*'] }), 'interactive')
    assert.strictEqual(classify({}), 'interactive')
  })

  it('reports pool state even while admission is disabled', () => {
    // Enables a dry run: see what would have been shed before enforcing.
    const stats = QueryClassifier.getAdmissionStats()
    assert.isFalse(stats.enabled, 'default must be disabled — 429 needs client coordination')
    assert.property(stats.heavy, 'depth')
    assert.property(stats.interactive, 'depth')
  })
})
