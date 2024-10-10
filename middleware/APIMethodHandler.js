const Solrjs = require('solrjs')
const Config = require('../config')
const SOLR_URL = Config.get('solr').url
const debug = require('debug')('p3api-server:middleware/APIMethodHandler')
const http = require('http')
const Web = require('../web');

var solrAgent = Web.getSolrAgent();

function streamQuery (req, res, next) {
  if (req.call_method !== 'stream') {
    next()
  }

  const query = req.call_params[0]
  const solrClient = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solrClient.setAgent(solrAgent)

  debug('streamSOLR() query: ', query)

  solrClient.stream(query)
    .then((results) => {
      res.results = results
      next()
    }, (err) => {
      console.error(`Error StreamingQuery SOLR: ${err}`)
      next(err)
    })
}

function querySOLR (req, res, next) {
  if (req.call_method !== 'query') {
    next()
  }

  const query = req.call_params[0]
  const solrClient = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solrClient.setAgent(solrAgent)

  debug('querySOLR() query: ', query)

  solrClient.query(query)
    .then((results) => {
      if (!results) {
        res.results = []
      } else if (results.response) {
        res.results = results
      } else if (results.grouped) {
        res.results = results
      } else if (results.error) {
        console.error(`[${(new Date()).toISOString()}] ${req.url}`, req.headers, results)
        res.status(400).send('A Database Error Occured:\n\t' + JSON.stringify(results.error, null, 4))
        return
      } else {
        res.results = []
      }

      next()
    }, (err) => {
      console.error(`Error Querying SOLR: ${err}`)
      next(err)
    })
}

function getSOLR (req, res, next) {
  const solrClient = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solrClient.setAgent(solrAgent)

  solrClient.get(req.call_params[0])
    .then((sresults) => {
      if (sresults && sresults.doc) {
        const results = sresults.doc

        if (results.public || (req.publicFree.indexOf(req.call_collection) >= 0) || (results.owner === (req.user)) || (results.user_read && results.user_read.indexOf(req.user) >= 0)) {
          res.results = sresults
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
      } else if (sresults && sresults.response && sresults.response.docs) {
        // handle for multiple ids in get request
        const results = sresults.response.docs[0]

        if (results.public || (req.publicFree.indexOf(req.call_collection) >= 0) || (results.owner === (req.user)) || (results.user_read && results.user_read.indexOf(req.user) >= 0)) {
          res.results = sresults.response
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
    }, (err) => {
      console.error(`Error in SOLR Get: ${err}`)
      next(err)
    })
}

function getSchema (req, res, next) {
  const solrClient = new Solrjs(SOLR_URL + '/' + req.call_collection)
  solrClient.setAgent(solrAgent)

  solrClient.getSchema()
    .then((body) => {
      if (body && typeof body === 'string') {
        body = JSON.parse(body)
      }
      res.results = body
      next()
    }, (err) => {
      console.error(`Error in Solr Schema: ${err}`)
      next(err)
    })
}

module.exports = function (req, res, next) {
  res.queryStart = new Date()

  switch (req.call_method) {
    case 'query':
      return querySOLR(req, res, next)
    case 'get':
      return getSOLR(req, res, next)
    case 'schema':
      return getSchema(req, res, next)
    case 'stream':
      return streamQuery(req, res, next)
  }
}
