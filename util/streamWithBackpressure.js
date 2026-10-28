/**
 * Stream with Backpressure Utility
 *
 * Provides proper backpressure handling for streaming data to HTTP responses.
 * This replaces EventStream.mapSync() which does NOT handle backpressure,
 * leading to unbounded memory growth with large datasets.
 *
 * Usage:
 *   await streamWithBackpressure(sourceStream, res, {
 *     transform: (doc) => JSON.stringify(doc) + '\n',
 *     onHeader: (firstDoc) => 'header,row\n',
 *     onEnd: (docCount) => console.log(`Sent ${docCount} docs`)
 *   })
 */

/**
 * Stream data from a source stream to an HTTP response with proper backpressure.
 *
 * @param {ReadableStream} sourceStream - Source stream in object mode
 * @param {Response} res - Express response object
 * @param {Object} options - Configuration options
 * @param {Function} options.transform - Transform function (doc, index) => string|null
 * @param {Function} [options.onFirstDoc] - Called with first doc (usually metadata/header to skip)
 * @param {Function} [options.onHeader] - Called with first real doc to generate header row
 * @param {Function} [options.onEnd] - Called when stream ends with doc count
 * @param {boolean} [options.skipFirstDoc=true] - Whether to skip the first document (metadata)
 * @param {number} [options.dribbleMs=0] - Enable the dribble reserve; 0 disables.
 * @param {number} [options.reserveBytes=256] - Bytes held back to spend during silence.
 * @returns {Promise<number>} Resolves with document count when complete
 */
/**
 * THE DRIBBLE RESERVE — surviving Cloudflare's silence budget without inventing bytes.
 *
 * Cloudflare terminates a response that goes quiet for too long, even after it has
 * started. Measured against alpha through the production chain (2026-10-28):
 *
 *     60s / 100s / 120s gap -> complete        150s gap -> CUT at 127s, truncated
 *
 * and the cut returns HTTP **200** with a short body, because the status line went out
 * with the first chunk. A download can therefore fail while looking successful.
 *
 * This matters because a sparse batched join legitimately produces nothing for minutes:
 * `annotation:"PATRIC"` over Viruses walks hundreds of genome slices matching none.
 *
 * WHY NOT SYNTHESISED FILLER. The obvious fix is to emit a keepalive byte, and it founders
 * on format legality: a blank line is fine in CSV and FASTA, and arbitrary bytes are not
 * insertable into binary xlsx at all. (JSON would in fact tolerate whitespace between
 * tokens — RFC 8259 — but that only rescues one more format, not all of them.)
 *
 * WHAT THIS DOES INSTEAD. Hold back the tail of what has already been produced, and spend
 * it ONE BYTE AT A TIME while the producer is quiet. No byte is invented; the output is
 * byte-identical and only its timing changes, so it is correct for every serializer
 * including binary ones.
 *
 * A single byte is enough. Measured: one space written every 100 s, three times, kept a
 * 300-second response alive to completion — three gaps each longer than the one that
 * killed the 150 s test.
 *
 * WHAT IT DOES NOT COVER. The reserve must be non-empty when the silence starts, so this
 * protects gaps BETWEEN records, not a slow first record. A walk that is barren from byte
 * zero still needs the producer to reach its first row promptly.
 */
function makeDribbleReserve (res, { dribbleMs, reserveBytes }) {
  let reserve = Buffer.alloc(0)
  let timer = null
  let ended = false

  const stop = () => { if (timer) { clearInterval(timer); timer = null } }

  const tick = () => {
    if (ended || reserve.length === 0 || res.writableEnded || res.destroyed) return
    // One byte. Enough to reset the budget, small enough that a long quiet stretch is
    // survivable from a modest reserve: 256 bytes at one per 60s is over four hours.
    res.write(reserve.subarray(0, 1))
    reserve = reserve.subarray(1)
  }

  return {
    /**
     * Write `chunk`, holding back the last `reserveBytes` of the stream so far. Returns
     * the same boolean res.write would, so the caller's backpressure handling is
     * unchanged.
     */
    write (chunk) {
      if (ended) return true
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const all = reserve.length ? Buffer.concat([reserve, buf]) : buf
      const keep = Math.min(reserveBytes, all.length)
      const send = all.subarray(0, all.length - keep)
      reserve = all.subarray(all.length - keep)

      // Restart the idle clock: real data has just moved, so the budget is reset by it.
      stop()
      timer = setInterval(tick, dribbleMs)
      if (timer.unref) timer.unref()

      return send.length ? res.write(send) : true
    },

    /** Release everything held back. Must be called before res.end(). */
    flush () {
      ended = true
      stop()
      if (reserve.length) {
        res.write(reserve)
        reserve = Buffer.alloc(0)
      }
    },

    stop
  }
}

function streamWithBackpressure (sourceStream, res, options = {}) {
  const {
    transform,
    onFirstDoc,
    onHeader,
    onEnd,
    skipFirstDoc = true,
    // Off by default: changes write timing on every streaming response, so it is opted
    // into by the paths that can actually stall. 60s is half the measured 120-150s budget.
    dribbleMs = 0,
    reserveBytes = 256
  } = options

  // Disable nginx proxy buffering to enable end-to-end backpressure
  // This header tells nginx to pass data through without buffering.
  // Guard on headersSent: some callers (e.g. json.js) write a prefix such as
  // '[' before invoking this helper, which flushes the response headers. Setting
  // a header after that throws ERR_HTTP_HEADERS_SENT, which would reject the
  // whole stream. Those callers set X-Accel-Buffering themselves before writing.
  if (res.set && !res.headersSent) {
    res.set('X-Accel-Buffering', 'no')
  }

  const dribble = dribbleMs > 0
    ? makeDribbleReserve(res, { dribbleMs, reserveBytes })
    : null
  // Single write path so the dribble cannot be bypassed by one of the three call sites.
  const writeOut = (chunk) => (dribble ? dribble.write(chunk) : res.write(chunk))

  return new Promise((resolve, reject) => {
    let isFirstDoc = true
    let headerWritten = false
    let docCount = 0
    let destroyed = false

    const cleanup = () => {
      if (!destroyed) {
        destroyed = true
        if (dribble) dribble.stop()
        sourceStream.removeAllListeners()
        res.removeListener('drain', onDrain)
        res.removeListener('close', onClose)
      }
    }

    const onDrain = () => {
      if (!destroyed) {
        sourceStream.resume()
      }
    }

    const onClose = () => {
      // Client disconnected
      if (!res.writableEnded && !destroyed) {
        cleanup()
        sourceStream.destroy()
      }
    }

    sourceStream.on('data', (doc) => {
      if (destroyed) return

      // Handle first document (usually metadata to skip)
      if (isFirstDoc && skipFirstDoc) {
        isFirstDoc = false
        if (onFirstDoc) {
          onFirstDoc(doc)
        }
        return // Skip first document
      }
      isFirstDoc = false

      // Handle header row (called once with first real document)
      if (!headerWritten && onHeader) {
        const header = onHeader(doc)
        if (header != null) {
          const canContinue = writeOut(header)
          if (!canContinue) {
            sourceStream.pause()
          }
        }
        headerWritten = true
      }

      // Transform and write the document
      if (transform) {
        const output = transform(doc, docCount)
        if (output != null) {
          const canContinue = writeOut(output)
          if (!canContinue) {
            sourceStream.pause()
          }
        }
      }
      docCount++
    })

    res.on('drain', onDrain)
    res.on('close', onClose)

    sourceStream.on('end', () => {
      if (destroyed) return
      cleanup()
      // Release the held-back tail BEFORE onEnd, which may append its own trailer
      // (media/json.js writes the closing ']'), and certainly before res.end().
      if (dribble) dribble.flush()
      if (onEnd) {
        onEnd(docCount)
      }
      res.end()
      resolve(docCount)
    })

    sourceStream.on('error', (err) => {
      cleanup()
      reject(err)
    })
  })
}

module.exports = {
  streamWithBackpressure
}
