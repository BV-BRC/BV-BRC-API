const Rql = require('solrjs/rql')
const debug = require('debug')('RQLQueryParser')
const Expander = require('../ExpandingQuery')

// Sanitize error messages to prevent XSS
function sanitizeErrorMessage(message) {
  if (!message) return 'Invalid query'
  // Remove HTML tags and limit length
  return String(message).replace(/[<>"'&]/g, '').substring(0, 200)
}

module.exports = function (req, res, next) {
  if (req.queryType === 'rql') {
    req.call_params[0] = req.call_params[0] || ''

    try {
      // catch parsing errors
      Expander.ResolveQuery(req.call_params[0], { req: req, res: res })
        .then((q) => {
          debug('Resolved Query: ', q)
          if (q === '()') { q = '' }
          const rq = Rql(q)
          const max = (req.isDownload) ? 999999999 : 25000
          req.call_params[0] = rq.toSolr({ maxRequestLimit: max, defaultLimit: 25 })
          debug(`Converted Solr Query: ${req.call_params[0]}`)
          req.queryType = 'solr'
          next()
        })
        .catch((err) => {
          console.error(`${err}`)
          const safeMessage = sanitizeErrorMessage(err.message)
          res.status(400).send({ status: 400, message: safeMessage })
        })
    } catch (err) {
      console.error(`[${(new Date()).toISOString()}] Unable to resolve RQL query. ${err.message}. Send 400`)
      const safeMessage = sanitizeErrorMessage(err.message)
      res.status(400).send({ status: 400, message: safeMessage })
    }
  } else {
    next()
  }
}
