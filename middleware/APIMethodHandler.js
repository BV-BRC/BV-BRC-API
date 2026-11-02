const Solrjs = require('../lib/solrjs')
const Config = require('../config')
const SOLR_URL = Config.get('solr').url
const debug = require('debug')('p3api-server:middleware/APIMethodHandler')
const http = require('http')
const Web = require('../web');

var solrAgent = Web.getSolrAgent();

// Request timeout for every Solr call on the main data path.
//
// The pooled agent is keepAlive, so Node can hand a request a socket the far side
// (HAProxy, per Docs/GENBANK_DOWNLOAD_PERFORMANCE.md) has already dropped. A silent
// LB drop leaves no FIN, so the socket looks alive and cannot be probed before use;
// the request is written into a dead connection and waits for the OS to tear down
// the TCP session — measured at ~166s. Cloudflare's 100s origin limit fires long
// before that, so the user gets a 524 while the worker is still holding one of the
// agent's `maxSockets` slots.
//
// This timer is the detection mechanism: it turns a multi-minute hang into a prompt
// error, frees the socket slot, and lets the client retry against a fresh connection.
// The symptom it addresses is intermittent — a query that hangs once and succeeds on
// reload is landing on a stale socket, not doing more work.
//
// Set SOLR_REQUEST_TIMEOUT_MS=0 to disable (restores the previous hang-forever
// behavior). Default 120000: comfortably above the slowest legitimate query observed
// in production (~75s Solr time on broad facet queries) so it never truncates real
// work, while still well under Cloudflare's limit for the common case.
const SOLR_REQUEST_TIMEOUT_MS = process.env.SOLR_REQUEST_TIMEOUT_MS !== undefined
  ? parseInt(process.env.SOLR_REQUEST_TIMEOUT_MS, 10)
  : 120000

// Build a Solr client for `collection` with the shared pooled agent, the request
// timeout, and the authenticated-user header applied consistently. Every Solr call
// in this module goes through here so no path can silently miss the timeout.
function makeSolrClient (collection, user) {
  const solrClient = new Solrjs(SOLR_URL + '/' + collection)
  solrClient.setAgent(solrAgent)
  if (SOLR_REQUEST_TIMEOUT_MS) {
    solrClient.timeout = SOLR_REQUEST_TIMEOUT_MS
  }
  if (user) {
    solrClient.setHeaders({ 'X-Authenticated-User': user })
  }
  return solrClient
}

function streamQuery (req, res, next) {
  if (req.call_method !== 'stream') {
    return next()
  }

  // Skip if distributed query already handled this request
  if (req.skipAPIMethodHandler && res.results) {
    debug('Skipping streamQuery - handled by distributed query')
    return next()
  }

  const query = req.call_params[0]
  const solrClient = makeSolrClient(req.call_collection, req.user)

  debug('streamSOLR() query: ', query)

  solrClient.stream(query)
    .then(async (results) => {
      // Pipe through join enrichment stream if join specs were prepared
      if (req._joinSpecs && req._joinSpecs.length > 0 && results.stream) {
        try {
          const JoinEnrichmentStream = require('../lib/distributed/JoinEnrichmentStream')
          const { getJoiner } = require('./JoinEnrichment')
          const joiner = await getJoiner()

          const joinStream = new JoinEnrichmentStream(joiner, {
            joinSpecs: req._joinSpecs,
            batchSize: 50,
            skipHeader: true, // Solrjs stream emits metadata header first
            user: req.user,
            publicFree: req.publicFree
          })

          results.stream = results.stream.pipe(joinStream)
          debug('Piped stream through JoinEnrichmentStream')
        } catch (err) {
          debug(`Failed to set up stream join enrichment: ${err.message}`)
        }
      }

      res.results = results
      next()
    }, (err) => {
      console.error(`Error StreamingQuery SOLR: ${err}`)
      next(err)
    })
}

function querySOLR (req, res, next) {
  if (req.call_method !== 'query') {
    return next()
  }

  // Skip if distributed query already handled this request
  if (req.skipAPIMethodHandler && res.results) {
    debug('Skipping querySOLR - handled by distributed query')
    return next()
  }

  const query = req.call_params[0]
  const url = SOLR_URL + '/' + req.call_collection;
  const solrClient = makeSolrClient(req.call_collection, req.user)

  debug('querySOLR() query: ', query)

  solrClient.query(query)
    .then((results) => {
      if (!results) {
        res.results = []
      } else if (results.response) {
        res.results = results
        // Capture nextCursorMark for cursor-based pagination
        if (results.nextCursorMark) {
          res.nextCursorMark = results.nextCursorMark
        }
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
      console.error(`Error Querying SOLR: ${err} user=${req.user} url=${url} qry=${query}`)
      next(err)
    })
}

function getSOLR (req, res, next) {
  const solrClient = makeSolrClient(req.call_collection, req.user)

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
        // Check permissions on EVERY document, not just the first
        const isPublicFree = req.publicFree.indexOf(req.call_collection) >= 0

        const authorizedDocs = sresults.response.docs.filter((doc) => {
          return doc.public || isPublicFree || (doc.owner === req.user) || (doc.user_read && doc.user_read.indexOf(req.user) >= 0)
        })

        if (authorizedDocs.length > 0) {
          sresults.response.docs = authorizedDocs
          sresults.response.numFound = authorizedDocs.length
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
  const solrClient = makeSolrClient(req.call_collection)

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

// Exported so routes/dataType.js's /fields endpoint can read a collection schema
// through the same configured client (TLS, agents, SOLR_REQUEST_TIMEOUT_MS) rather
// than building a second one that would drift.
module.exports.makeSolrClient = makeSolrClient
