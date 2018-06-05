var debug = require('debug')('p3api-server:media/tsv')
var when = require('promised-io/promise').when
var es = require('event-stream')

module.exports = {
  contentType: 'text/tsv',
  serialize: function (req, res, next) {
    debug('application/tsv handler')
    debug('Method: ', req.call_method)
    var fields = req.fieldSelection
    var header = req.fieldHeader

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.txt')
      // res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.txt"');
    }

    if (req.call_method == 'stream') {
      when(res.results, function (results) {
        var docCount = 0
        var head
        results.stream.pipe(es.mapSync(function (data) {
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
                return '"' + data[field].map(function (v) { return v.replace(/"/g, "'") }).join(';') + '"'
              } else if (data[field]) {
                if (typeof data[field] == 'string') {
                  return '"' + data[field].replace(/"/g, "'") + '"'
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
      })
    } else if (req.call_method == 'query') {
      if (res.results && res.results.response && res.results.response.docs) {
        if (!fields) {
          fields = Object.keys(res.results.response.docs[0])
        }
        res.write(fields.join('\t') + '\n')
        res.results.response.docs.forEach(function (o) {
          var row = fields.map(function (field) {
            if (o[field] instanceof Array) {
              return '"' + o[field].map(function (v) { return v.replace(/"/g, "'") }).join(';') + '"'
            } else if (o[field]) {
              if (typeof o[field] == 'string') {
                return '"' + o[field].replace(/"/g, "'") + '"'
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
