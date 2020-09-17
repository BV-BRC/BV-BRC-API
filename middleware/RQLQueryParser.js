const Rql = require('solrjs/rql')
const debug = require('debug')('RQLQueryParser')
const Expander = require('../ExpandingQuery')

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
    } catch (err) {
      console.error(`[${(new Date()).toISOString()}] Unable to resolve RQL query for ${req.call_params[0]}. ${err.message}. Send 400`)
      res.status(400).send(err.message)
    }
  } else {
    next()
  }
}
