/**
 * Visibility into HTTP agent socket pools.
 *
 * Why this exists: `maxSockets` caps *concurrency*, not queue depth. A request that
 * cannot get a socket waits in `agent.requests`, and Node's http.Agent provides no cap
 * on that queue — there is no maxQueue/maxPending option. Measured, 192 requests queued
 * behind a pool of 8. That queue is where load silently accumulates, and until now
 * nothing reported it: `/stats` tracked a single `active_requests` counter.
 *
 * Phase 2 of Docs/COMPLETION_PLAN-2026-10.md sizes admission pools against the socket
 * pools, on the rule *admission pool <= socket pool, so the socket queue stays empty*.
 * That rule cannot be checked, or the sizes tuned, without seeing whether the agent
 * queue is actually empty. Hence this.
 *
 * Registration is explicit and best-effort: an unregistered agent is simply absent from
 * the report, never an error. Nothing here affects request handling.
 */

// name -> agent. A plain object, not a Map, because the set is tiny, fixed at startup,
// and the only consumer serializes it to JSON.
const registry = {}

/**
 * Register an agent for reporting.
 *
 * Re-registering a name replaces the entry: agents are built once at module load, but a
 * test (or a config reload) may legitimately build a second one, and the newest is the
 * one actually in use.
 *
 * @param {string} name - Stable label, e.g. 'solr.main'
 * @param {Object} agent - http.Agent or https.Agent
 * @returns {Object} the agent, so call sites can wrap construction inline
 */
function registerAgent (name, agent) {
  if (name && agent) {
    registry[name] = agent
  }
  return agent
}

/**
 * Count entries across an agent's per-host buckets.
 *
 * `agent.sockets`, `.freeSockets` and `.requests` are keyed by host:port:options, with
 * array values. Summing across keys gives the process-wide figure, which is what
 * matters here — per-host detail belongs to Layer 3 (see the plan) and is deliberately
 * not reported.
 */
function countBuckets (buckets) {
  if (!buckets) {
    return 0
  }
  let total = 0
  for (const key of Object.keys(buckets)) {
    const bucket = buckets[key]
    total += Array.isArray(bucket) ? bucket.length : 0
  }
  return total
}

/**
 * Snapshot one agent.
 *
 * `queued` is the number to watch. Non-zero under normal load means requests are
 * waiting for sockets — the unobservable queue this module exists to expose.
 *
 * @param {Object} agent
 * @returns {Object} { active, free, queued, maxSockets, maxFreeSockets }
 */
function agentSnapshot (agent) {
  if (!agent) {
    return null
  }
  return {
    active: countBuckets(agent.sockets),
    free: countBuckets(agent.freeSockets),
    queued: countBuckets(agent.requests),
    // Infinity is the Node default and does not survive JSON.stringify (it becomes
    // null), so report it as a string to keep the field readable.
    maxSockets: agent.maxSockets === Infinity ? 'unlimited' : agent.maxSockets,
    maxFreeSockets: agent.maxFreeSockets === Infinity ? 'unlimited' : agent.maxFreeSockets
  }
}

/**
 * Snapshot every registered agent.
 *
 * Defensive: a malformed agent yields an error marker for that entry rather than
 * breaking the whole /stats response. A stats endpoint that 500s during an incident is
 * worse than one reporting a partial answer.
 *
 * @returns {Object} name -> snapshot
 */
function getAgentStats () {
  const out = {}
  for (const name of Object.keys(registry)) {
    try {
      out[name] = agentSnapshot(registry[name])
    } catch (err) {
      out[name] = { error: err.message }
    }
  }
  return out
}

/** Total requests waiting for a socket across all registered agents. */
function totalQueued () {
  let total = 0
  for (const name of Object.keys(registry)) {
    try {
      total += countBuckets(registry[name] && registry[name].requests)
    } catch (err) {
      // ignore a malformed agent in the aggregate
    }
  }
  return total
}

/** Drop all registrations. Tests only. */
function resetRegistry () {
  for (const name of Object.keys(registry)) {
    delete registry[name]
  }
}

module.exports = {
  registerAgent,
  getAgentStats,
  agentSnapshot,
  totalQueued,
  resetRegistry
}
