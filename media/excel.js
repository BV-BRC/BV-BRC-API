var debug = require('debug')('p3api-server:media/excel')
var xlsx = require('node-xlsx')

module.exports = {
  contentType: 'application/vnd.openxmlformats',
  serialize: function (req, res, next) {
    debug('application/vnd.openxmlformats handler')
    debug('Method: ', req.call_method)
    var fields = req.fieldSelection
    var header = req.fieldHeader

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.xlsx')
      // res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.xlsx"');
    }

    res.set('Content-Type', 'application/vnd.openxmlformats')

    if (res.results && res.results.response && res.results.response.docs) {
      if (!fields) {
        fields = Object.keys(res.results.response.docs[0])
      }

      // debug("fields: ", fields);
      const data = res.results.response.docs.map(function (o) {
        return fields.map(function (field) {
          if (typeof o[field] === 'object') {
            if (o[field] instanceof Array) {
              return o[field].join(';')
            }
            return JSON.stringify(o[field])
          }
          return o[field] || ''
        })
        // return row;
      })

      if (header) {
        data.unshift(header)
      } else {
        data.unshift(fields)
      }

      var d = xlsx.build([{name: 'patric3_query', data: data}])
      res.end(d, 'binary')
    } else {
      res.status(404)
      // res.end();
    }
  }
}
