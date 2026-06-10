const { streamWithBackpressure } = require('../util/streamWithBackpressure')

function encapsulateStringArray (listOfVals) {
  return `"${listOfVals.map((val) => (val && typeof val === 'string') ? val.replace(/"/g, "'") : val).join(';')}"`
}

function formatField (data, field) {
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
}

module.exports = {
  contentType: 'text/csv',
  serialize: function (req, res, next) {
    let fields = req.fieldSelection
    const header = req.fieldHeader

    if (req.isDownload) {
      res.attachment('BVBRC_' + req.call_collection + '.csv')
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then(async (vals) => {
        const results = vals[0]
        let localFields = fields

        await streamWithBackpressure(results.stream, res, {
          onHeader: (firstDoc) => {
            if (!localFields) {
              localFields = Object.keys(firstDoc)
            }
            if (header) {
              return header.join(',') + '\n'
            } else {
              return localFields.join(',') + '\n'
            }
          },
          transform: (data) => {
            const row = localFields.map((field) => formatField(data, field))
            return row.join(',') + '\n'
          }
        })
      }).catch((error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else if (req.call_method === 'query') {
      if (res.results && res.results.response && res.results.response.docs) {
        if (!fields) {
          fields = Object.keys(res.results.response.docs[0])
        }
        if (header) {
          res.write(header.join(',') + '\n')
        } else {
          res.write(fields.join(',') + '\n')
        }
        res.results.response.docs.forEach((data) => {
          const row = fields.map((field) => formatField(data, field))
          res.write(row.join(',') + '\n')
        })
        res.end()
      }
    } else {
      next(new Error('Unable to serialize request to csv'))
    }
  }
}
