var debug = require('debug')('p3api-server:media')
var media = require('../media')

module.exports = function (req, res, next) {
  res.formatStart = new Date()

  var rpcTypes = ['application/jsonrpc.result+json', 'application/jsonrpc+json']

  if (rpcTypes.some(function (t) {
    return req.is(t)
  })) {
    debug('RPC Request')
  }

  req.isDownload = !!(req.headers && req.headers.download)

  res.format(media)
}
