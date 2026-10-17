const http = require('http')
const https = require('https')
const { withUserAgent } = require('../lib/userAgent')

/**
 * WALL-CLOCK DEADLINES — PLAN_ELIMINATE_SELF_CALL.md step 7.
 *
 * Before this, `util/http.js` had no timeout mechanism *at all* — not merely unset,
 * absent. Every helper here could hang until the OS tore the TCP session down. That is
 * the recurring failure mode in this codebase: an outbound call with no deadline. The
 * classic trigger is a pooled keepAlive socket the far side has already dropped; a silent
 * drop leaves no FIN, so the socket cannot be probed before use and the write simply never
 * gets an answer. Measured at ~166s in Docs/GENBANK_DOWNLOAD_PERFORMANCE.md — long enough
 * that Cloudflare's ~100s origin limit fires first and the user sees a 524 while the worker
 * still holds the slot.
 *
 * WHY NOT `req.setTimeout`, WHICH IS WHAT lib/solrjs's armTimeout() USES
 * ---------------------------------------------------------------------
 * `req.setTimeout` is a *socket* timeout: the timer does not start until the agent hands
 * the request a socket. Time spent queued behind `maxSockets` is therefore unbounded, and
 * the worst case is (unbounded queue wait) + timeout. Verified with maxSockets:1 against a
 * black-hole server — a request with a 2000ms timeout was still pending after 6000ms.
 * Recorded as gap 1 of two in Docs/HANG-INVESTIGATION-2026-08-24.md.
 *
 * So the timer here starts at request *creation* and covers queue wait, connect, TLS,
 * write, and the whole response body. One deadline, no gap.
 *
 * The timer is cleared on 'end' and on 'error'. An armed timer that outlives its request
 * keeps the event loop alive for the rest of the interval, which would hang short-lived
 * scripts and the test suite.
 */

// Same env-var pattern and default as SOLR_REQUEST_TIMEOUT_MS on the main data path
// (lib/internalQuery.js, middleware/APIMethodHandler.js). Set to 0 to disable.
const DEFAULT_TIMEOUT_MS = process.env.HTTP_REQUEST_TIMEOUT_MS !== undefined
  ? parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS, 10)
  : 120000

const noop = () => {}

// Per-call `options.timeout` overrides the default; 0 or null disables the deadline for
// that call. Note node's own http.request already understands an `options.timeout`, where
// it means a socket timeout that emits 'timeout' without destroying anything — nothing
// here registers that listener, so it was inert. Reusing the key gives it a meaning.
function deadlineFor (options) {
  const t = options && options.timeout
  return t === undefined ? DEFAULT_TIMEOUT_MS : t
}

// Query strings are stripped: these messages reach clients, and a self-call path carries
// the caller's filter.
function targetOf (options, url) {
  if (url) {
    return String(url).split('?')[0]
  }
  if (!options) {
    return 'unknown host'
  }
  const host = options.hostname || options.host || 'localhost'
  const port = options.port ? `:${options.port}` : ''
  return `${host}${port}${options.path || ''}`.split('?')[0]
}

/**
 * Start the deadline. Returns the function that cancels it.
 *
 * Rejects with its own error rather than letting `req.destroy(err)` surface through the
 * caller's 'error' handler: those handlers render `err.code`, so an abort of our own making
 * would read as a network fault instead of a timeout. `reject` is idempotent, so the
 * 'error' the destroy then emits is harmless — but the destroy is still required, or the
 * socket stays checked out of the pool after the promise has settled.
 *
 * @param {Object}   req        The ClientRequest to bound.
 * @param {number}   timeoutMs  Deadline in ms; falsy means no deadline.
 * @param {Function} reject     The promise's reject.
 * @param {string}   target     Host/path for the message.
 * @returns {Function} cancel
 */
function armDeadline (req, timeoutMs, reject, target) {
  if (!timeoutMs || timeoutMs < 0) {
    return noop
  }
  const timer = setTimeout(() => {
    const err = new Error(`Request to ${target} timed out after ${timeoutMs}ms`)
    err.code = 'ETIMEDOUT'
    reject(err)
    req.destroy(err)
  }, timeoutMs)
  return () => clearTimeout(timer)
}

module.exports = {
  // Like httpRequest, but resolves { statusCode, body } instead of just the body.
  //
  // Every other helper here throws away res.statusCode, so a caller cannot tell a
  // 500 from a 200 — it just gets the response body as a string. Callers that
  // JSON.parse the result then store an error object where rows should be, and the
  // failure is invisible: the outer request returns HTTP 200 with a body that looks
  // structurally plausible. See routes/multiQuery.js for the case this was added for.
  //
  // Added rather than changing httpRequest's resolve shape, because that helper has
  // four other call sites that expect a bare string.
  'httpRequestWithStatus': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve({ statusCode: res.statusCode, body: rawData })
        })
        res.on('error', (err) => {
          cancel()
          reject(new Error(`Unable to receive a response. ${err.code || err}`))
        })
      })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code || err}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpGet': async (options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = http.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
        res.on('error', (err) => {
          cancel()
          reject(err)
        })
      })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
    })
  },
  'httpsGet': async (options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = https.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
        res.on('error', (err) => {
          cancel()
          reject(err)
        })
      })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
    })
  },
    'requestUrlForUrl': (url) => {
	const parsed = new URL(url);
	return parsed.protocol === "http:" ? module.exports.httpRequestUrl : module.exports.httpsRequestUrl;
    },

  'httpRequest': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpsRequest': async (options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  // The deadline covers the upload too: streamableBody feeds req.write as it arrives, so a
  // producer that stalls mid-body is bounded by the same timer.
  'httpStreamRequest': async (options, streamableBody) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        cancel()
        reject(err)
      })
    })
  },
  'httpsStreamRequest': async (options, streamableBody) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        cancel()
        reject(err)
      })
    })
  },
  'httpsGetUrl': async (url, options) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options, url)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = https.get(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
        res.on('error', (err) => {
          cancel()
          reject(err)
        })
      })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.on('error', (err) => {
        cancel()
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
    })
  },
  'httpsRequestUrl': async (url, options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options, url)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = https.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.write(body)
	req.end()
    })
  },
  'httpRequestUrl': async (url, options, body) => {
    options = { ...options, headers: withUserAgent(options && options.headers) }
    const timeoutMs = deadlineFor(options)
    const target = targetOf(options, url)
    return new Promise((resolve, reject) => {
      let cancel = noop
      const req = http.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          cancel()
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          cancel()
          reject(err)
        })
      cancel = armDeadline(req, timeoutMs, reject, target)
      req.write(body)
      req.end()
    })
  }
}

// The effective default, for tests and for callers that want to reason about it.
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
