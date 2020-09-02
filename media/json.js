const EventStream = require('event-stream')

module.exports = {
  contentType: 'application/json',
  serialize: function (req, res, next) {
    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        let docCount = 0
        let head

        res.write('[')
        results.stream.pipe(EventStream.mapSync(function (data) {
          if (!head) {
            head = data
          } else {
            res.write(((docCount > 0) ? ',' : '') + JSON.stringify(data))
            docCount++
          }
        })).on('end', function () {
          res.write(']')
          res.end()
        })
      }, (error) => {
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
      if (!res.results || !res.results.doc) {
        res.status(404)
      } else {
        res.send(JSON.stringify(res.results.doc))
      }
      res.end()
    }
  }
}
