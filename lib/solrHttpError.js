/**
 * Errors for non-2xx responses from Solr, carrying the status code.
 *
 * Every Solr client in this tree used to collapse a non-2xx response into a bare
 * `Error(\`HTTP ${statusCode}: ...\`)`, discarding the code. That is fine until something
 * needs to tell *which* failure it was — and one case matters:
 *
 *   A 429 from Solr means "I am overloaded, stop sending". `ShardCursorStream`'s retry
 *   loop treated every rejection as retriable and retried up to `maxRetries` times with
 *   backoff, so a node shedding load received up to four requests instead of one, per
 *   shard, from every worker. The signal that exists to reduce load amplified it.
 *
 * Solr emits 429 from its circuit breakers and its request rate limiter (Layer 4 of
 * PLAN_SOLR_OVERLOAD_PROTECTION.md), so this has to be right before either is enabled —
 * see Docs/ADMISSION_CONTROL_STATUS-2026-10.md.
 */

/**
 * An HTTP error from Solr that remembers its status code.
 *
 * `statusCode` is the property name the rest of the codebase already keys off
 * (`lib/internalQuery.js` sets it; `routes/dataRouter.js` reads it), so callers that
 * map upstream failures to a client-facing status keep working unchanged.
 */
class SolrHttpError extends Error {
  /**
   * @param {number} statusCode - HTTP status from Solr
   * @param {string} message - Human-readable message
   * @param {Object} [options]
   * @param {number|null} [options.retryAfterMs] - Parsed Retry-After, in ms
   */
  constructor (statusCode, message, options = {}) {
    super(message)
    this.name = 'SolrHttpError'
    this.statusCode = statusCode
    this.retryAfterMs = options.retryAfterMs === undefined ? null : options.retryAfterMs

    // app.js's terminal error handler reads `error.status`, while internalQuery and
    // dataRouter read `statusCode`. Set both so an overload status reaches the client as
    // itself rather than being flattened to 500 — but only for statuses a client should
    // actually see. A 4xx/5xx from Solr that reflects *our* malformed query (400, 404)
    // must not be echoed as the client's own status, since the client's request was fine.
    if (statusCode === 429 || statusCode === 503) {
      this.status = statusCode
    }
  }

  /** True when Solr is shedding load (429) or briefly unavailable (503). */
  get isOverloaded () {
    return this.statusCode === 429 || this.statusCode === 503
  }
}

/**
 * Parse a Retry-After header into milliseconds.
 *
 * Two formats are legal (RFC 9110): delta-seconds, and an HTTP-date. Solr sends
 * delta-seconds, but a proxy in front of it may rewrite to a date, so both are handled.
 * Returns null when absent or unparseable — callers fall back to their own backoff.
 *
 * @param {string|undefined} headerValue
 * @param {number} [nowMs] - Injectable clock, for tests
 * @returns {number|null} Delay in ms, or null
 */
function parseRetryAfter (headerValue, nowMs = Date.now()) {
  if (headerValue === undefined || headerValue === null) {
    return null
  }

  const raw = String(headerValue).trim()
  if (raw === '') {
    return null
  }

  // delta-seconds. Guard against a bare "0" being treated as "no header" by callers —
  // 0 is a legitimate "retry immediately", so it is returned as 0, not null.
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10) * 1000
  }

  // HTTP-date
  const when = Date.parse(raw)
  if (Number.isNaN(when)) {
    return null
  }
  // A date in the past means retry now, not a negative delay.
  return Math.max(0, when - nowMs)
}

/**
 * Build a SolrHttpError from a response, for the non-2xx branch of a client.
 *
 * @param {Object} res - Node http.IncomingMessage (needs statusCode and headers)
 * @param {string} body - Response body, already accumulated
 * @param {Object} [options]
 * @param {string} [options.context] - Prefix for the message, e.g. "Shard shard1"
 * @param {number} [options.maxBodyLength=200] - Body characters to include
 * @returns {SolrHttpError}
 */
function solrHttpError (res, body, options = {}) {
  const { context, maxBodyLength = 200 } = options
  const statusCode = res && res.statusCode
  const headers = (res && res.headers) || {}
  const retryAfterMs = parseRetryAfter(headers['retry-after'])

  const snippet = typeof body === 'string' ? body.slice(0, maxBodyLength) : ''
  const prefix = context ? `${context}: ` : ''
  const retryNote = retryAfterMs === null ? '' : ` (Retry-After: ${retryAfterMs}ms)`

  return new SolrHttpError(
    statusCode,
    `${prefix}HTTP ${statusCode}${retryNote}: ${snippet}`,
    { retryAfterMs }
  )
}

/**
 * Should a failed request be retried on the same replica?
 *
 * Retrying a 4xx is pointless — the request is malformed or refused, and it will be
 * refused identically next time. The one exception is 429, which is retriable *in
 * principle* but must be paced by the server's Retry-After rather than by our own
 * backoff, and is handled separately by callers so it does not consume the
 * connection-failure retry budget.
 *
 * A rejection with no statusCode is a transport error (connect refused, socket timeout,
 * JSON parse failure) and stays retriable, preserving existing behavior.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetriable (err) {
  const statusCode = err && err.statusCode
  if (typeof statusCode !== 'number') {
    return true // transport error — unchanged from previous behavior
  }
  if (statusCode === 429) {
    return true // retriable, but pace it with Retry-After; see shouldHonorRetryAfter
  }
  if (statusCode >= 400 && statusCode < 500) {
    return false // malformed/refused — retrying cannot help
  }
  return true // 5xx: transient server-side, worth another attempt
}

module.exports = {
  SolrHttpError,
  solrHttpError,
  parseRetryAfter,
  isRetriable
}
