const EventStream = require('event-stream')

function encapsulateStringArray (listOfVals) {
  return `"${listOfVals.map((val) => (val && typeof val === 'string') ? val.replace(/"/g, "'") : val).join(';')}"`
}
module.exports = {
  contentType: 'text/tsv',
  serialize: function (req, res, next) {
    var fields = req.fieldSelection
    var header = req.fieldHeader

    if (req.isDownload) {
      res.attachment(`PATRIC_${req.call_collection}.txt`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        let docCount = 0
        let head

        results.stream.pipe(EventStream.mapSync((data) => {
          if (!head) {
            head = data
          } else {
            if (!fields && docCount < 1) {
              fields = Object.keys(data)
            }
            if (docCount < 1) {
              if (header) {
                res.write(header.join('\t') + '\n')
              } else {
                res.write(fields.join('\t') + '\n')
              }
            }
            var row = fields.map(function (field) {
              if (data[field] instanceof Array) {
                return encapsulateStringArray(data[field])
              } else if (data[field]) {
                if (typeof data[field] === 'string') {
                  return `"${data[field].replace(/"/g, "'")}"`
                } else {
                  return data[field]
                }
              } else {
                return ''
              }
            })
            res.write(row.join('\t') + '\n')
            docCount++
          }
        })).on('end', function () {
          res.end()
        })
      }, (error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else if (req.call_method === 'query') {
      if (res.results && res.results.response && res.results.response.docs) {
        if (!fields) {
          fields = Object.keys(res.results.response.docs[0])
        }
        res.write(fields.join('\t') + '\n')
        res.results.response.docs.forEach(function (o) {
          var row = fields.map(function (field) {
            if (o[field] instanceof Array) {
              return encapsulateStringArray(o[field])
            } else if (o[field]) {
              if (typeof o[field] === 'string') {
                return `"${o[field].replace(/"/g, "'")}"`
              } else {
                return o[field]
              }
            } else {
              return ''
            }
          })

          res.write(row.join('\t') + '\n')
        })
        res.end()
      }
    } else {
      next(new Error('Unable to serialize request to csv'))
    }
  }
}
