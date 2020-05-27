var Solrjs = require('solrjs')
// var media = require("../middleware/media");
var config = require('../config')
var SOLR_URL = config.get('solr').url
var debug = require('debug')('p3api-server:middleware/DownloadAPIMethodHandler')
var when = require('promised-io/promise').when
var http = require('http')

var solrAgentConfig = config.get('solr').agent
var solrAgent = new http.Agent(solrAgentConfig)

var querySOLR = function (req, res, next) {
  if (req.call_method !== 'query') {
    next()
  }

  var query = req.call_params[0]
  // debug("querySOLR() req.params", req.call_params);
  var solr = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solr.setAgent(solrAgent)
  debug('querySOLR() query: ', query)
  when(solr.query(query), function (results) {
    // debug("APIMethodHandler solr.query results: ", results)
    if (!results) {
      res.results = []
    } else if (results.response) {
      res.results = results
    } else if (results.grouped) {
      res.results = results
    } else {
      res.results = []
    }
    next()
  }, function (err) {
    debug('Error Querying SOLR: ', err)
    next(err)
  })
}
var getSOLR = function (req, res, next) {
  var solr = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solr.setAgent(solrAgent)
  when(solr.get(req.call_params[0]), function (sresults) {
    if (sresults && sresults.doc) {
      var results = sresults.doc

      if (results.public || (req.publicFree.indexOf(req.call_collection) >= 0) || (results.owner === (req.user)) || (results.user_read && results.user_read.indexOf(req.user) >= 0)) {
        res.results = sresults
        // debug("Results: ", results);
        next()
      } else {
        if (!req.user) {
          debug('User not logged in, permission denied')
          res.sendStatus(401)
        } else {
          debug('User forbidden from private data')
          res.sendStatus(403)
        }
      }
    } else {
      next()
    }
  }, function (err) {
    debug('Error in SOLR Get: ', err)
    next(err)
  })
}

module.exports = function (req, res, next) {
  if (req.cacheHit && res.results) {
    next()
    return
  }
  debug('API Method MIDDLEWARE')

  res.queryStart = new Date()
  // debug("query START: ",res.queryStart);
  switch (req.call_method) {
    case 'query':
      return querySOLR(req, res, next)
      // break
    case 'get':
      return getSOLR(req, res, next)
      // break
  }
}
