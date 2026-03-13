/**
 * NDJSON (Newline Delimited JSON) Media Handler
 *
 * NDJSON is superior to JSON arrays for streaming:
 * - No array wrapper needed (each line is independent)
 * - Can be parsed incrementally
 * - Better for large datasets
 * - Standard format: https://ndjson.org/
 */

const { streamWithBackpressure } = require('../util/streamWithBackpressure')

module.exports = {
  contentType: 'application/x-ndjson',
  serialize: function (req, res, next) {
    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.ndjson`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then(async (vals) => {
        const results = vals[0]

        await streamWithBackpressure(results.stream, res, {
          transform: (doc) => JSON.stringify(doc) + '\n'
        })
      }).catch((error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else if (req.call_method === 'query') {
      if (res.results && res.results.response && res.results.response.docs) {
        res.results.response.docs.forEach((doc) => {
          res.write(JSON.stringify(doc) + '\n')
        })
      }
      res.end()
    } else {
      // req.call_method === get
      if (!res.results) {
        res.status(404)
      } else {
        res.write(JSON.stringify(res.results.doc || res.results.docs) + '\n')
      }
      res.end()
    }
  }
}
