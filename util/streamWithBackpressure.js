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
 * @returns {Promise<number>} Resolves with document count when complete
 */
function streamWithBackpressure (sourceStream, res, options = {}) {
  const {
    transform,
    onFirstDoc,
    onHeader,
    onEnd,
    skipFirstDoc = true
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

  return new Promise((resolve, reject) => {
    let isFirstDoc = true
    let headerWritten = false
    let docCount = 0
    let destroyed = false

    const cleanup = () => {
      if (!destroyed) {
        destroyed = true
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
          const canContinue = res.write(header)
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
          const canContinue = res.write(output)
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
