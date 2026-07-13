'use strict'

// Shared retry / commit-rollback / history-update logic for the index workers
// (bin/p3-index-worker-once and bin/p3-index-worker). Keeping it here means both
// workers classify errors and drive the maildir queue transaction identically.
//
// Queue semantics (file-queue maildir): popping a message renames its file
// new/ -> cur/ and hands back commit(cb) [unlink from cur/] and rollback(cb)
// [rename cur/ -> new/]. queue.length() counts only new/. So:
//   - commit()   => message is done, removed from the queue.
//   - rollback() => message returns to the queue for the next worker run.
// Historically both were commented out, which stranded every popped message in
// cur/ forever: errored jobs never retried and successful jobs leaked.

const Path = require('path')
const fs = require('fs-extra')
const Config = require('../config')
const mailer = require('./mailer')

const STATE_SUBMITTED = 'submitted'
const STATE_RETRYING = 'retrying'
const STATE_ERROR = 'error'

// Tag an error as transient (worth retrying). Applied at the source — anything
// exiting the Solr POST path. Default is permanent, so an unclassified error is
// never retried (safer than burning 30 attempts on a genuinely-bad job).
function markTransient (err) {
  if (err && typeof err === 'object') { err.transient = true }
  return err
}

function isTransient (err) {
  return !!(err && typeof err === 'object' && err.transient)
}

function errMessage (err) {
  if (err && err.message) { return err.message }
  return String(err)
}

function readAttempts (queueDirectory, id) {
  try {
    const data = fs.readJsonSync(Path.join(queueDirectory, 'history', id))
    return (data && typeof data.attempts === 'number') ? data.attempts : 0
  } catch (e) {
    return 0
  }
}

// Merge-patch a history file. Preserves fields not named in `patch`.
function patchHistory (queueDirectory, id, patch) {
  return new Promise((resolve, reject) => {
    const historyPath = Path.join(queueDirectory, 'history', id)
    fs.readJson(historyPath, (err, data) => {
      if (err) { reject(err); return }
      Object.assign(data, patch)
      fs.writeJson(historyPath, data, (werr) => {
        if (werr) { reject(werr); return }
        resolve(data)
      })
    })
  })
}

// maildir commit/rollback take a node-style callback. Wrap as promises; log but
// don't fail the chain if the fs op errors (history is already updated).
function runTxn (fn, label, log) {
  return new Promise((resolve) => {
    if (typeof fn !== 'function') { resolve(); return }
    fn((err) => {
      if (err && log) { log(`${(new Date()).toISOString()}: queue ${label} failed: ${err}`) }
      resolve()
    })
  })
}

/**
 * Resolve one popped message: update history, then commit or rollback the queue
 * transaction according to the outcome.
 *
 * @param {object} o
 * @param {string} o.queueDirectory
 * @param {string} o.id            history/queue id
 * @param {string} o.genomeId
 * @param {function} o.commit       maildir commit(cb)
 * @param {function} o.rollback     maildir rollback(cb)
 * @param {object}  o.outcome       { ok:true } | { ok:false, err }
 * @param {number}  o.maxAttempts
 * @param {Array}   o.transientFailures  accumulator for the run-summary email
 * @param {Array}   o.deferredRollbacks  accumulator of rollback fns to run at drain
 * @param {function} [o.log]
 * @returns {Promise}
 *
 * IMPORTANT: on a transient retry we do NOT roll back inline. rollback renames
 * the message cur/ -> new/, and processQueue immediately re-reads new/ and would
 * re-pop the same message, burning all attempts in a single run. Instead we leave
 * the file in cur/ (uncounted by queue.length) and register the rollback to run
 * once the queue has drained, so the retry lands on the NEXT worker run.
 */
function finishMessage (o) {
  const { queueDirectory, id, genomeId, commit, rollback, outcome, maxAttempts, transientFailures, deferredRollbacks, log } = o
  const doCommit = () => runTxn(commit, 'commit', log)

  if (outcome.ok) {
    return patchHistory(queueDirectory, id, {
      state: STATE_SUBMITTED, genomeId, submissionTime: new Date()
    }).then(doCommit)
  }

  const err = outcome.err
  const msg = errMessage(err)

  if (isTransient(err)) {
    const attempts = readAttempts(queueDirectory, id) + 1
    if (attempts < maxAttempts) {
      // Retry next run: leave the file in cur/, defer the rollback to drain time.
      transientFailures.push({ id, genomeId, attempts, error: msg, giveUp: false })
      if (deferredRollbacks && rollback) { deferredRollbacks.push(rollback) }
      return patchHistory(queueDirectory, id, {
        state: STATE_RETRYING, attempts, lastError: msg, lastAttemptTime: new Date()
      })
    }
    // Exhausted retries — give up, drop from queue.
    transientFailures.push({ id, genomeId, attempts, error: msg, giveUp: true })
    return patchHistory(queueDirectory, id, {
      state: STATE_ERROR, attempts, error: msg
    }).then(doCommit)
  }

  // Permanent failure — drop from queue, no retry.
  return patchHistory(queueDirectory, id, {
    state: STATE_ERROR, error: msg
  }).then(doCommit)
}

// Run all deferred rollbacks (cur/ -> new/) sequentially. Call once the queue
// has drained so retried messages reappear on the next run, not this one.
function runDeferredRollbacks (deferredRollbacks, log) {
  let p = Promise.resolve()
  ;(deferredRollbacks || []).forEach((rb) => {
    p = p.then(() => runTxn(rb, 'rollback', log))
  })
  return p
}

// Send one summary email if any transient failures occurred this run. Resolves
// to null (no send) when there were none or no recipient is configured.
function sendRunSummary (transientFailures) {
  if (!transientFailures || transientFailures.length === 0) { return Promise.resolve(null) }

  const mailconf = Config.get('email') || {}
  const to = mailconf.indexAlertTo
  if (!to) { return Promise.resolve(null) }

  const retrying = transientFailures.filter((f) => !f.giveUp)
  const gaveUp = transientFailures.filter((f) => f.giveUp)

  const lines = []
  lines.push(`The BV-BRC genome index worker hit ${transientFailures.length} transient failure(s) this run.`)
  lines.push('')
  if (retrying.length) {
    lines.push(`Will retry next run (${retrying.length}):`)
    retrying.forEach((f) => lines.push(`  ${f.id}  genome=${f.genomeId}  attempt ${f.attempts}  ${f.error}`))
    lines.push('')
  }
  if (gaveUp.length) {
    lines.push(`Gave up after reaching the attempt cap (${gaveUp.length}) — now in permanent error state:`)
    gaveUp.forEach((f) => lines.push(`  ${f.id}  genome=${f.genomeId}  attempt ${f.attempts}  ${f.error}`))
  }

  const subject = `[BV-BRC] index worker: ${transientFailures.length} transient failure(s), ${gaveUp.length} gave up`
  return mailer.sendReport({ to, subject, text: lines.join('\n') })
}

function maxAttempts () {
  const mailconf = Config.get('email') || {}
  return mailconf.indexMaxAttempts || 30
}

module.exports = {
  markTransient,
  isTransient,
  finishMessage,
  runDeferredRollbacks,
  sendRunSummary,
  maxAttempts
}
