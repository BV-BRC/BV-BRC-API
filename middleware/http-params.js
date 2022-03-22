const debug = require('debug')('p3api-server:http-params')
const URL = require('url')

module.exports = function (req, res, next) {
  req._parsedUrl = URL.parse(req.url, false, false)

  if (req._parsedUrl.query) {
    var parsed = {}
    if (typeof req._parsedUrl.query === 'string') {
      var q = req._parsedUrl.query
      q.split('&').forEach(function (qp) {
        var parts = qp.split('=')
        parsed[parts[0]] = parts[1] || ''
      })
    }

    debug('req.url', req.url, parsed)

    if (parsed) {
      Object.keys(parsed).forEach((key) => {
        if (key.match('http_')) {
          const header = key.split('_')[1]
          req.headers[header] = decodeURIComponent(parsed[key])
          delete parsed[key]
        }
      })

      const keys = Object.keys(parsed)
      if (keys.length < 1) {
        req._parsedUrl.search = ''
      } else {
        const search = keys.map((key) => {
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

  next()
}
