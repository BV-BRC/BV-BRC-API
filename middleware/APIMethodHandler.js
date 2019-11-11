var Solrjs = require('solrjs')
// var media = require("../middleware/media");
var config = require('../config')
var SOLR_URL = config.get('solr').url
var debug = require('debug')('p3api-server:middleware/APIMethodHandler')
var when = require('promised-io/promise').when
var request = require('request')

var streamQuery = function (req, res, next) {
  if (req.call_method !== 'stream') {
    next()
  }

  var query = req.call_params[0]
  // debug("querySOLR() req.params", req.call_params);
  var solr = new Solrjs(SOLR_URL + '/' + req.call_collection)
  debug('querySOLR() query: ', query)
  when(solr.stream(query), function (results) {
    // debug("APIMethodHandler solr.streamQuery results: ", results);
    res.results = results
    next()
  }, function (err) {
    debug('Error StreamingQuery SOLR: ', err)
    next(err)
  })
}

var querySOLR = function (req, res, next) {
  if (req.call_method !== 'query') {
    next()
  }

  var query = req.call_params[0]
  // debug("querySOLR() req.params", req.call_params);
  var solr = new Solrjs(SOLR_URL + '/' + req.call_collection)
  debug('querySOLR() query: ', query)
  when(solr.query(query), function (results) {
    // debug('APIMethodHandler solr.query response code: ', results.responseHeader.status)
    if (!results) {
      res.results = []
    } else if (results.response) {
      res.results = results
    } else if (results.grouped) {
      res.results = results
    }else if (results.error) {
      console.error(`[${(new Date()).toISOString()}] ${req.url}`, req.headers, results)
      res.status(400).send('A Database Error Occured\n' + JSON.stringify(results.error))
      return;
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

var getSchema = function (req, res, next) {
  debug(SOLR_URL + '/' + req.call_collection + '/schema')
  request.get({
    url: SOLR_URL + '/' + req.call_collection + '/schema',
    headers: {
      accept: 'application/json'
    }
  }, function (err, r, body) {
    // debug("Distribute RESULTS: ", body);
    // debug("schema results: "+body);
    // debug("r.headers: ", r.headers);
    if (err) {
      debug('Error in SOLR Get: ', err)
      return next(err)
    }

    if (body && typeof body === 'string') {
      body = JSON.parse(body)
    }
    res.results = body
    next()
  })
}

module.exports = function (req, res, next) {
  if (req.cacheHit && res.results) {
    next()
    return
  }
  // debug('API Method MIDDLEWARE')

  res.queryStart = new Date()
  // debug("query START: ",res.queryStart);
  switch (req.call_method) {
    case 'query':
      return querySOLR(req, res, next)
      // break
    case 'get':
      return getSOLR(req, res, next)
      // break
    case 'schema':
      return getSchema(req, res, next)
      // break
    case 'stream':
      return streamQuery(req, res, next)
      // break
  }
}
