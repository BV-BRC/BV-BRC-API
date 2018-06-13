var rql = require('solrjs/rql')
var debug = require('debug')('p3api-server:RQLQueryParser')
var when = require('promised-io/promise').when
var Expander = require('../ExpandingQuery')

module.exports = function (req, res, next) {
  debug('QueryType: ', req.queryType)
  if (req.queryType === 'rql') {
    req.call_params[0] = req.call_params[0] || ''
    // debug("Orig Query: ", req.call_params[0]);
    when(Expander.ResolveQuery(req.call_params[0], {req: req, res: res}), function (q) {
      debug('Resolved Query: ', q)
      if (q === '()') { q = '' }
      var rq = rql(q)
      var max = 25000;
      if (req.isDownload){
        max=999999999;
      }
   
      req.call_params[0] = rq.toSolr({maxRequestLimit: max, defaultLimit: 25})
      // debug("Converted Solr Query: ", req.call_params[0]);
      req.queryType = 'solr'
      next()
    })
  } else {
    next()
  }
}
