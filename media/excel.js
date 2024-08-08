const NodeXlsx = require('node-xlsx')

module.exports = {
  contentType: 'application/vnd.openxmlformats',
  serialize: function (req, res, next) {
    let fields = req.fieldSelection
    const header = req.fieldHeader

    console.log(JSON.stringify(["excel serialization start", new Date().toISOString(), { queryType: req.queryType, params: req.call_params, collection: req.call_collection }]));

    // console.log(JSON.stringify(["excel data", new Date().toISOString(), res.results]));

    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.xlsx`)
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

	    console.log(JSON.stringify(["excel start stringify", new Date().toISOString()]));
	    // console.log(JSON.stringify(["excel data", new Date().toISOString(), data]));
      var d = NodeXlsx.build([{ name: 'patric3_query', data: data }], { parseOptions: {dense: true}})
       console.log(JSON.stringify(["excel serialization complete", new Date().toISOString()]));
      res.end(d, 'binary')
    } else {
      res.status(404)
    }
  }
}
