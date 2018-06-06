var debug = require('debug')('p3api-server:http-params')
var URL = require('url')
var querystring = require('querystring')

module.exports = function (req, res, next) {
  // debug("Begin http-params Middleware: ", req.query, "URL: ", req.url," PARSED:", req._parsedUrl)

  // if (!req._parsedUrl){
  req._parsedUrl = URL.parse(req.url, false, false)
  // }
  if (req._parsedUrl.query) {
    var parsed = {}
    if (typeof req._parsedUrl.query === 'string') {
      var q = req._parsedUrl.query
      var qparts = q.split('&').forEach(function (qp) {
        var parts = qp.split('=')
        parsed[parts[0]] = parts[1] || ''
      })
    }

    debug('req.url', req.url, parsed)

    if (parsed) {
      Object.keys(parsed).forEach(function (key) {
        if (key.match('http_')) {
          var header = key.split('_')[1]
          req.headers[header] = decodeURIComponent(parsed[key])
          delete parsed[key]
        }
      })

      // req._parsedUrl.query = parsed;
      var keys = Object.keys(parsed)
      if (keys.length < 1) {
        req._parsedUrl.search = ''
      } else {
        var search = keys.map(function (key) {
          if (!parsed[key]) {
            return key
          } else {
            return key + '=' + parsed[key]
          }
        }).join('&')
        req._parsedUrl.search = search
      }

      req._parsedUrl.path = req._parsedUrl.pathname + ((req._parsedUrl.search.charAt(0) === '?') ? req._parsedUrl.search : ('?' + req._parsedUrl.search))
      req._parsedUrl.href = req._parsedUrl.path
      req.url = URL.format(req._parsedUrl)
      req._parsedUrl.query = '?' + req._parsedUrl.search
      debug('set req.query to ', req._parsedUrl.search)
    }
  } else {
    req._parsedUrl.query = ''
  }

  debug('End http-params Middleware: ', req._parsedUrl, req._parsedUrl.query)
  // console.log("Headers: ", req.headers);
  next()
}
