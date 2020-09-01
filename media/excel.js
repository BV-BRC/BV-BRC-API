const NodeXlsx = require('node-xlsx')

module.exports = {
  contentType: 'application/vnd.openxmlformats',
  serialize: function (req, res, next) {
    let fields = req.fieldSelection
    const header = req.fieldHeader

    if (req.isDownload) {
      res.attachment(`PATRIC_${req.call_collection}.xlsx`)
    }

    res.set('Content-Type', 'application/vnd.openxmlformats')

    if (res.results && res.results.response && res.results.response.docs) {
      if (!fields) {
        fields = Object.keys(res.results.response.docs[0])
      }

      const data = res.results.response.docs.map((doc) => {
        return fields.map(function (field) {
          if (typeof doc[field] === 'object') {
            if (doc[field] instanceof Array) {
              return doc[field].join(';')
            }
            return JSON.stringify(doc[field])
          }
          return doc[field] || ''
        })
      })

      if (header) {
        data.unshift(header)
      } else {
        data.unshift(fields)
      }

      var d = NodeXlsx.build([{ name: 'patric3_query', data: data }])
      res.end(d, 'binary')
    } else {
      res.status(404)
    }
  }
}
