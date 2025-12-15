const debug = require('debug')('p3api-server:http-params')
const URL = require('url')

// Whitelist of allowed headers that can be set via query parameters
const ALLOWED_HEADERS = ['accept', 'range', 'content-type']

// Sanitize header values to prevent XSS
function sanitizeHeaderValue(value) {
  if (!value) return ''
  // Remove any HTML tags and dangerous characters
  return String(value).replace(/[<>"'&]/g, '')
}

// Validate parameter names to prevent XSS via parameter names
function isValidParameterName(name) {
  // Only allow alphanumeric, underscore, hyphen, dot, parentheses, and comma
  // This allows RQL syntax like eq(field,value) but blocks <script> tags
  return /^[a-zA-Z0-9_\-.,()]+$/.test(name)
}

module.exports = function (req, res, next) {
  req._parsedUrl = URL.parse(req.url, false, false)

  if (req._parsedUrl.query) {
    var parsed = {}
    if (typeof req._parsedUrl.query === 'string') {
      var q = req._parsedUrl.query
      q.split('&').forEach(function (qp) {
        var parts = qp.split('=')
        var paramName = parts[0]
        
        // Validate parameter name to prevent XSS
        if (!isValidParameterName(paramName)) {
          console.warn(`[SECURITY] Blocked invalid parameter name: ${paramName.substring(0, 50)}`)
          return // Skip this parameter
        }
        
        parsed[paramName] = parts[1] || ''
      })
    }

    debug('req.url', req.url, parsed)

    if (parsed) {
      Object.keys(parsed).forEach((key) => {
        if (key.match(/^http_/)) {
          const header = key.split('_')[1]
          
          // Only allow whitelisted headers
          if (!ALLOWED_HEADERS.includes(header.toLowerCase())) {
            debug(`Blocked attempt to set unauthorized header: ${header}`)
            delete parsed[key]
            return
          }
          
          // Sanitize the header value to prevent XSS
          const rawValue = decodeURIComponent(parsed[key])
          const sanitizedValue = sanitizeHeaderValue(rawValue)
          
          // Log if sanitization changed the value (potential attack)
          if (rawValue !== sanitizedValue) {
            console.warn(`[SECURITY] Sanitized potentially malicious header value for ${header}: ${rawValue}`)
          }
          
          req.headers[header] = sanitizedValue
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
