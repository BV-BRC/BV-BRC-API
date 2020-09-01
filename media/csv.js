const EventStream = require('event-stream')

function encapsulateStringArray (listOfVals) {
  return `"${listOfVals.map((val) => (val && typeof val === 'string') ? val.replace(/"/g, "'") : val).join(';')}"`
}

module.exports = {
  contentType: 'text/csv',
  serialize: function (req, res, next) {
    let fields = req.fieldSelection
    const header = req.fieldHeader

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.csv')
    }
    // console.log(`media type csv, call_method: ${req.call_method}`)

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
                res.write(header.join(',') + '\n')
              } else {
                res.write(fields.join(',') + '\n')
              }
            }

            const row = fields.map((field) => {
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
            res.write(row.join(',') + '\n')
            docCount++
          }
        })).on('end', () => {
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
        res.write(fields.join(',') + '\n')
        res.results.response.docs.forEach((data) => {
          const row = fields.map((field) => {
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

          res.write(row.join(',') + '\n')
        })
        res.end()
      }
    } else {
      next(new Error('Unable to serialize request to csv'))
    }
  }
}
