const { streamWithBackpressure } = require('../util/streamWithBackpressure')

module.exports = {
  contentType: 'application/json',
  serialize: function (req, res, next) {
    if (req.call_method === 'stream') {
      Promise.all([res.results]).then(async (vals) => {
        const results = vals[0]
        let isFirst = true

        // Set the nginx no-buffering header BEFORE the first write flushes the
        // response headers. streamWithBackpressure also tries to set it, but by
        // the time it runs we've already written '[' and headers are sent.
        if (res.set) {
          res.set('X-Accel-Buffering', 'no')
        }
        res.write('[')
        await streamWithBackpressure(results.stream, res, {
          transform: (data) => {
            const prefix = isFirst ? '' : ','
            isFirst = false
            return prefix + JSON.stringify(data)
          },
          onEnd: () => {
            res.write(']')
          }
        })
      }).catch((error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else if (req.call_method === 'query') {
      if (res.results && res.results.response && res.results.facet_counts) {
        res.set('facet_counts', JSON.stringify(res.results.facet_counts))
      }
      if (res.results && res.results.response && res.results.response.docs) {
        res.send(JSON.stringify(res.results.response.docs))
      } else if (res.results && res.results.grouped) {
        res.send(JSON.stringify(res.results.grouped))
      } else {
        res.status(404)
      }
      res.end()
    } else if (req.call_method === 'schema') {
      res.send(JSON.stringify(res.results))
      res.end()
    } else {
      // req.call_method === get
      if (!res.results) {
        res.status(404)
      } else {
        res.send(JSON.stringify(res.results.doc || res.results.docs))
      }
      res.end()
    }
  }
}
