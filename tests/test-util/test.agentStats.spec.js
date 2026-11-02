/**
 * Agent socket-pool visibility (lib/agentStats.js).
 *
 * Why this matters: `maxSockets` caps concurrency, not queue depth, and Node's
 * http.Agent exposes no cap on the queue of requests waiting for a socket — there is no
 * maxQueue option. Load therefore accumulates in `agent.requests` where, until now,
 * nothing could see it: /stats reported a single `active_requests` counter.
 *
 * Phase 2 of Docs/COMPLETION_PLAN-2026-10.md sizes admission pools on the rule
 * "admission pool <= socket pool, so the socket queue stays empty". These tests pin the
 * measurement that rule is checked against — in particular that `queued` is non-zero
 * when requests really are waiting, which is the whole point.
 *
 * Fully offline: a local black-hole server, no Solr/Redis/API.
 */

const assert = require('chai').assert
const http = require('http')

const {
  registerAgent,
  getAgentStats,
  agentSnapshot,
  totalQueued,
  resetRegistry
} = require('../../lib/agentStats')

describe('agentStats', () => {
  afterEach(() => resetRegistry())

  describe('registerAgent', () => {
    it('returns the agent so construction can be wrapped inline', () => {
      const agent = new http.Agent()
      assert.strictEqual(registerAgent('x', agent), agent)
      agent.destroy()
    })

    it('ignores a missing name or agent rather than throwing', () => {
      assert.doesNotThrow(() => registerAgent(null, new http.Agent()))
      assert.doesNotThrow(() => registerAgent('y', null))
      assert.deepStrictEqual(getAgentStats(), {})
    })

    it('replaces an existing registration of the same name', () => {
      const a = new http.Agent({ maxSockets: 1 })
      const b = new http.Agent({ maxSockets: 2 })
      registerAgent('dup', a)
      registerAgent('dup', b)
      assert.strictEqual(getAgentStats().dup.maxSockets, 2)
      a.destroy(); b.destroy()
    })
  })

  describe('agentSnapshot', () => {
    it('reports an idle agent as all zeros', () => {
      const agent = new http.Agent({ maxSockets: 8 })
      const snap = agentSnapshot(agent)
      assert.strictEqual(snap.active, 0)
      assert.strictEqual(snap.free, 0)
      assert.strictEqual(snap.queued, 0)
      assert.strictEqual(snap.maxSockets, 8)
      agent.destroy()
    })

    it('renders an unlimited pool as a string, since Infinity is not JSON', () => {
      // JSON.stringify(Infinity) is null, which would read as "unset" in /stats
      const agent = new http.Agent() // maxSockets defaults to Infinity
      const snap = agentSnapshot(agent)
      assert.strictEqual(snap.maxSockets, 'unlimited')
      assert.notStrictEqual(JSON.parse(JSON.stringify(snap)).maxSockets, null)
      agent.destroy()
    })

    it('returns null for a missing agent', () => {
      assert.isNull(agentSnapshot(null))
      assert.isNull(agentSnapshot(undefined))
    })
  })

  describe('against a saturated pool', () => {
    let blackHole
    let port

    beforeEach((done) => {
      blackHole = http.createServer(() => {}) // accepts, never answers
      blackHole.listen(0, '127.0.0.1', () => {
        port = blackHole.address().port
        done()
      })
    })

    afterEach((done) => {
      if (typeof blackHole.closeAllConnections === 'function') {
        blackHole.closeAllConnections()
      }
      blackHole.close(() => done())
    })

    it('THE POINT: reports requests queued behind a saturated pool', async () => {
      // maxSockets 2, eight requests in flight -> 2 active, 6 queued. Before this
      // module those six were invisible to every form of monitoring we had.
      const agent = new http.Agent({ keepAlive: true, maxSockets: 2 })
      registerAgent('saturated', agent)

      const inflight = []
      for (let i = 0; i < 8; i++) {
        const req = http.request({ port, agent, path: `/${i}` }, () => {})
        req.on('error', () => {})
        req.end()
        inflight.push(req)
      }

      await new Promise((resolve) => setTimeout(resolve, 200))

      const snap = getAgentStats().saturated
      assert.strictEqual(snap.active, 2, 'should have saturated the pool')
      assert.strictEqual(snap.queued, 6, 'the other six must show as queued')
      assert.strictEqual(snap.maxSockets, 2)
      assert.strictEqual(totalQueued(), 6)

      inflight.forEach((r) => r.destroy())
      agent.destroy()
    })

    it('shows an empty queue when the pool is big enough — the Phase 2 target state', async () => {
      // "admission pool <= socket pool, so the socket queue stays empty" is the rule
      // Phase 2 sizes against; this is what satisfying it looks like.
      const agent = new http.Agent({ keepAlive: true, maxSockets: 8 })
      registerAgent('roomy', agent)

      const inflight = []
      for (let i = 0; i < 3; i++) {
        const req = http.request({ port, agent, path: `/${i}` }, () => {})
        req.on('error', () => {})
        req.end()
        inflight.push(req)
      }

      await new Promise((resolve) => setTimeout(resolve, 200))

      const snap = getAgentStats().roomy
      assert.strictEqual(snap.active, 3)
      assert.strictEqual(snap.queued, 0, 'queue should be empty when sockets are available')
      assert.strictEqual(totalQueued(), 0)

      inflight.forEach((r) => r.destroy())
      agent.destroy()
    })

    it('sums queue depth across several registered agents', async () => {
      const a = new http.Agent({ keepAlive: true, maxSockets: 1 })
      const b = new http.Agent({ keepAlive: true, maxSockets: 1 })
      registerAgent('a', a)
      registerAgent('b', b)

      const inflight = []
      for (const agent of [a, b]) {
        for (let i = 0; i < 3; i++) {
          const req = http.request({ port, agent, path: `/${i}` }, () => {})
          req.on('error', () => {})
          req.end()
          inflight.push(req)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200))

      // 1 active + 2 queued on each
      assert.strictEqual(getAgentStats().a.queued, 2)
      assert.strictEqual(getAgentStats().b.queued, 2)
      assert.strictEqual(totalQueued(), 4)

      inflight.forEach((r) => r.destroy())
      a.destroy(); b.destroy()
    })
  })

  describe('robustness', () => {
    it('reports an error marker for a malformed agent instead of throwing', () => {
      // /stats must not 500 during an incident, which is exactly when it is read.
      registerAgent('broken', {
        get sockets () { throw new Error('boom') }
      })
      const stats = getAgentStats()
      assert.property(stats.broken, 'error')
      assert.strictEqual(stats.broken.error, 'boom')
    })

    it('keeps reporting healthy agents alongside a broken one', () => {
      const good = new http.Agent({ maxSockets: 4 })
      registerAgent('good', good)
      registerAgent('bad', { get sockets () { throw new Error('nope') } })

      const stats = getAgentStats()
      assert.strictEqual(stats.good.maxSockets, 4)
      assert.property(stats.bad, 'error')
      good.destroy()
    })

    it('totalQueued ignores a malformed agent rather than throwing', () => {
      registerAgent('bad', { get requests () { throw new Error('nope') } })
      assert.doesNotThrow(() => totalQueued())
      assert.strictEqual(totalQueued(), 0)
    })

    it('produces JSON-serializable output', () => {
      const agent = new http.Agent({ maxSockets: 8 })
      registerAgent('s', agent)
      assert.doesNotThrow(() => JSON.stringify(getAgentStats()))
      agent.destroy()
    })
  })
})
