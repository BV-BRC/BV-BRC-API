/**
 * Admission control — bounded concurrency with a short, bounded queue.
 *
 * WHY
 *
 * Two scraping incidents on 2026-06-02 overwhelmed the Solr cluster. The damage was not
 * the genome queries themselves but their amplification: each FASTA download fans out to
 * ~370 secondary feature_sequence lookups, which produced 15,000+ secondary queries in 30
 * minutes and drove shard host load averages to 200. The serializer concurrency caps
 * (Layer 2) bound the fan-out *per request*; nothing bounds **how many amplifying requests
 * run at once**. This does.
 *
 * WHY A QUEUE, WHEN THE PLAN SAID "NO QUEUING"
 *
 * Because "no queuing" is not available. `maxSockets: 8` already queues, inside Node's
 * http.Agent, and that queue has no cap — there is no maxQueue option, and measured, 192
 * requests piled up behind a pool of 8. It is also invisible (nothing reported it before
 * lib/agentStats.js) and, on the Solr path, was not time-bounded either.
 *
 * So the choice is not whether to queue but **where the queue lives and whether it is
 * bounded**. A short explicit queue here is strictly better than an unbounded implicit one
 * in the agent: it has a depth cap, a wait deadline, and it is observable.
 *
 * It also turns the common case from a rejection into a slightly slower success. Heavy
 * requests run for seconds; against a pool of 2-3, five arrivals in a second is a few
 * users and a script, not an attack. Rejecting them discards work the client must redo,
 * and clients retrying on 429 reproduce the retry amplification blamed for the 2026-06-05
 * coordinator crash.
 *
 * FOUR PROPERTIES THAT MATTER MORE THAN THE NUMBERS
 *
 *   1. Bounded depth AND a wait deadline. Either alone is insufficient: depth without a
 *      deadline lets a request wait forever behind slow work; a deadline without depth
 *      lets the queue grow without limit. Exceed either -> 429.
 *   2. The wait is measured from ARRIVAL, not from dequeue. Measuring from dequeue is the
 *      req.setTimeout mistake (see lib/solrjs/index.js armTimeout) one layer up.
 *   3. Queued entries whose client has disconnected are dropped at dequeue. Most abandoned
 *      bulk downloads are a closed tab; doing the work for nobody is pure waste.
 *   4. Everything is counted, for /stats. The pool sizes here are starting points and
 *      cannot be tuned without depth and oldest-wait.
 *
 * RELATIONSHIP TO THE SOCKET POOLS — do not "fix" this by shrinking maxSockets.
 *
 * The target is **admission pool <= socket pool, so the socket queue stays empty**. With
 * heavy admission at 2-3 and the main Solr agent at 8 sockets, admitted work gets a socket
 * immediately and the agent queue becomes slack rather than a load-bearing structure.
 * Lowering maxSockets would push load back into the unobservable queue.
 *
 * See Docs/ADMISSION_CONTROL_STATUS-2026-10.md and Docs/COMPLETION_PLAN-2026-10.md Phase 2.
 */

const debug = require('debug')('p3api-server:admission')

/**
 * Raised when a request cannot be admitted.
 *
 * Carries `status`/`statusCode` 429 (app.js's handler reads .status; internalQuery and
 * dataRouter read .statusCode) and `retryAfterSeconds` for the Retry-After header.
 */
class AdmissionRejectedError extends Error {
  constructor (message, details = {}) {
    super(message)
    this.name = 'AdmissionRejectedError'
    this.status = 429
    this.statusCode = 429
    this.retryAfterSeconds = details.retryAfterSeconds || 1
    Object.assign(this, details)
  }
}

/**
 * A counting semaphore with a bounded FIFO wait queue.
 *
 * Deliberately not a generic async-semaphore dependency: the behaviors that matter here
 * (arrival-time deadline, disconnect-aware dequeue, per-pool counters) are exactly the
 * ones a generic one would not have, and the whole thing is ~100 lines.
 */
class Pool {
  /**
   * @param {string} name
   * @param {Object} opts
   * @param {number} opts.maxConcurrent - slots
   * @param {number} opts.maxQueue - waiters allowed before rejecting
   * @param {number} opts.maxWaitMs - deadline measured from arrival
   */
  constructor (name, opts = {}) {
    this.name = name
    this.maxConcurrent = opts.maxConcurrent
    this.maxQueue = opts.maxQueue
    this.maxWaitMs = opts.maxWaitMs

    this.active = 0
    this.queue = [] // { resolve, reject, enqueuedAt, timer, isAbandoned }

    // Cumulative counters, for /stats. Never reset at runtime.
    this.admittedTotal = 0
    this.queuedTotal = 0
    this.rejectedQueueFullTotal = 0
    this.rejectedTimeoutTotal = 0
    this.abandonedTotal = 0
  }

  /** Requests currently waiting. */
  get depth () {
    return this.queue.length
  }

  /** Age of the oldest waiter in ms, or 0 when the queue is empty. */
  get oldestWaitMs () {
    if (this.queue.length === 0) {
      return 0
    }
    return Date.now() - this.queue[0].enqueuedAt
  }

  /**
   * Acquire a slot.
   *
   * @param {Object} [opts]
   * @param {Function} [opts.isAbandoned] - () => bool, checked at dequeue
   * @returns {Promise<Function>} release function; call exactly once
   */
  acquire (opts = {}) {
    if (this.active < this.maxConcurrent) {
      this.active++
      this.admittedTotal++
      return Promise.resolve(this._makeRelease())
    }

    if (this.queue.length >= this.maxQueue) {
      this.rejectedQueueFullTotal++
      debug(`${this.name}: queue full (${this.queue.length}/${this.maxQueue}), rejecting`)
      return Promise.reject(new AdmissionRejectedError(
        'The server is busy processing other large requests. Please retry shortly.',
        { pool: this.name, reason: 'queue_full', retryAfterSeconds: this._suggestRetryAfter() }
      ))
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        enqueuedAt: Date.now(),
        isAbandoned: opts.isAbandoned,
        timer: null
      }

      // The deadline runs from arrival, so it covers the whole wait rather than
      // restarting at dequeue. Property 2 above.
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry)
        if (idx !== -1) {
          this.queue.splice(idx, 1)
        }
        this.rejectedTimeoutTotal++
        debug(`${this.name}: waited ${this.maxWaitMs}ms without a slot, rejecting`)
        reject(new AdmissionRejectedError(
          'The server is busy processing other large requests. Please retry shortly.',
          { pool: this.name, reason: 'wait_timeout', retryAfterSeconds: this._suggestRetryAfter() }
        ))
      }, this.maxWaitMs)

      // Never let a queued request hold the event loop open by itself.
      if (typeof entry.timer.unref === 'function') {
        entry.timer.unref()
      }

      this.queue.push(entry)
      this.queuedTotal++
      debug(`${this.name}: queued (depth ${this.queue.length}/${this.maxQueue})`)
    })
  }

  /**
   * Suggest a Retry-After, in seconds.
   *
   * Derived from the wait deadline rather than fixed, so a pool configured to wait longer
   * also tells clients to come back later. Minimum 1s — a Retry-After of 0 invites the
   * tight-retry loop this is trying to avoid.
   */
  _suggestRetryAfter () {
    return Math.max(1, Math.ceil(this.maxWaitMs / 1000))
  }

  _makeRelease () {
    let released = false
    return () => {
      // Idempotent: a caller releasing twice would otherwise admit a phantom request.
      if (released) {
        return
      }
      released = true
      this.active--
      this._drain()
    }
  }

  /** Hand the freed slot to the next live waiter. */
  _drain () {
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      const entry = this.queue.shift()
      clearTimeout(entry.timer)

      // Property 3: skip a waiter whose client has gone. Free, and it avoids spending a
      // slot on work nobody will read.
      if (typeof entry.isAbandoned === 'function') {
        let abandoned = false
        try {
          abandoned = entry.isAbandoned()
        } catch (err) {
          abandoned = false // a throwing predicate must not drop a live request
        }
        if (abandoned) {
          this.abandonedTotal++
          debug(`${this.name}: dropped an abandoned waiter`)
          entry.reject(new AdmissionRejectedError('Client disconnected while queued', {
            pool: this.name,
            reason: 'abandoned'
          }))
          continue
        }
      }

      this.active++
      this.admittedTotal++
      entry.resolve(this._makeRelease())
    }
  }

  /** Snapshot for /stats. */
  stats () {
    return {
      active: this.active,
      max_concurrent: this.maxConcurrent,
      depth: this.depth,
      max_queue: this.maxQueue,
      oldest_wait_ms: this.oldestWaitMs,
      max_wait_ms: this.maxWaitMs,
      admitted_total: this.admittedTotal,
      queued_total: this.queuedTotal,
      rejected_queue_full_total: this.rejectedQueueFullTotal,
      rejected_timeout_total: this.rejectedTimeoutTotal,
      abandoned_total: this.abandonedTotal
    }
  }
}

module.exports = { Pool, AdmissionRejectedError }
