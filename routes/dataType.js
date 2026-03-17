var express = require('express')
var router = express.Router({ strict: true, mergeParams: true })
var RQLQueryParser = require('../middleware/RQLQueryParser')
var SOLRQueryParser = require('../middleware/SolrQueryParser')
var DecorateQuery = require('../middleware/DecorateQuery')
var ExtractCustomFields = require('../middleware/ExtractCustomFields')
var PublicDataTypes = require('../middleware/PublicDataTypes')
var authMiddleware = require('../middleware/auth')
var streamingHandler = require('../middleware/stream')
var Limiter = require('../middleware/Limiter')
var ContentRange = require('../middleware/content-range')
var APIMethodHandler = require('../middleware/APIMethodHandler')
var reqCounter = require('../middleware/ReqCounter')
var patchMiddleware = require('../middleware/patch')
var httpParams = require('../middleware/http-params')
var media = require('../middleware/media')
var bodyParser = require('body-parser')
var debug = require('debug')('p3api-server:route/dataType')
var querystring = require('querystring')
const ShardsPreference = require('../middleware/ShardsPreference')
const DistributedQuery = require('../middleware/DistributedQuery')
const JoinFieldInjector = require('../middleware/JoinFieldInjector')
const JoinEnrichment = require('../middleware/JoinEnrichment')

router.use(httpParams)

// Extract http_authorization from POST body before auth middleware runs
// This allows form-based downloads to pass authorization securely via POST body
// instead of URL query parameters (which can be logged/cached)
// We use bodyParser.raw to read the raw body, extract auth, then restore the body
router.use(function (req, res, next) {
  // Only process POST requests with form-urlencoded content type
  var ctype = req.get('content-type')
  if (req.method !== 'POST' || !ctype || !ctype.includes('application/x-www-form-urlencoded')) {
    return next()
  }

  // Collect body data
  var chunks = []
  req.on('data', function (chunk) {
    chunks.push(chunk)
  })
  req.on('end', function () {
    var bodyStr = Buffer.concat(chunks).toString()
    var parsed = querystring.parse(bodyStr)

    // Extract http_authorization if present
    if (parsed.http_authorization && !req.headers['authorization']) {
      req.headers['authorization'] = parsed.http_authorization
      debug('Set authorization header from POST body http_authorization')
      // Remove from parsed body
      delete parsed.http_authorization
      // Reconstruct body without http_authorization
      bodyStr = querystring.stringify(parsed)
    }

    // Store raw body string for later middleware to parse
    // We need to make the body available again for downstream body parsers
    req._authBodyParsed = true
    req._rawBody = bodyStr
    req.body = bodyStr

    next()
  })
  req.on('error', function (err) {
    next(err)
  })
})

router.use(authMiddleware)

router.use(PublicDataTypes)

// router.use(function(req,res,next){
//   debug("req.path", req.path);
//   debug("req content-type", req.get("content-type"));
//   debug("accept", req.get("accept"));
//   debug("req.url", req.url);
//   debug('req.path', req.path);
//   debug('req.params:', JSON.stringify(req.params));
//   next();
// });

router.use(function (req, res, next) {
  req.isDownload = !!(req.headers && req.headers.download)

  debug('REQ IS DOWNLOAD: ', req.isDownload)
  next()
})

router.get('*', function (req, res, next) {
  if (req.path === '/') {
    req.call_method = 'query'
    var ctype = req.get('content-type')

    debug('ctype: ', ctype)

    if (!ctype) {
      ctype = req.headers['content-type'] = 'application/x-www-form-urlencoded'
    }

    if (ctype === 'application/solrquery+x-www-form-urlencoded') {
      req.queryType = 'solr'
    } else {
      req.queryType = 'rql'
    }
    debug('req.queryType: ', req.queryType)
    debug('req.headers: ', req.headers)

    req.call_params = [req._parsedUrl.query || '']
    req.call_collection = req.params.dataType
  } else if (req.path === '/schema') {
    req.call_method = 'schema'
    req.call_params = []
    req.call_collection = req.params.dataType
  } else {
    if (req.params[0]) {
      req.params[0] = req.params[0].substr(1)
      var ids = decodeURIComponent(req.params[0]).split(',')
      if (ids.length === 1) {
        ids = ids[0]
      }
    }
    req.call_method = 'get'
    req.call_params = [ids]
    req.call_collection = req.params.dataType
  }

  next()
})

// patch/update objects
router.patch('/:target_id', [
  bodyParser.json({ type: ['application/jsonpatch+json'], limit: '100mb' }),
  patchMiddleware
])

// same thing as patch, but done over a post for clients that cannot issue the patch http verb
router.post('/:target_id', [
  bodyParser.json({ type: ['application/jsonpatch+json'], limit: '100mb' }),
  patchMiddleware
])

router.post('*', [
  bodyParser.json({ type: ['application/jsonrpc+json'], limit: '30mb' }),
  bodyParser.json({ type: ['application/json'], limit: '30mb' }),
  function (req, res, next) {
    debug('json req._body', req._body)
    if (!req._body || !req.body) {
      next()
      return
    }
    var ctype = req.get('content-type')
    if (req.body.jsonrpc || (ctype === 'application/jsonrpc+json')) {
      debug('JSON RPC Request', JSON.stringify(req.body, null, 4))
      if (!req.body.method) {
        throw Error('Invalid Method')
      }
      req.call_method = req.body.method
      req.call_params = req.body.params
      req.call_collection = req.params.dataType
    } else {
      // debug("JSON POST Request", JSON.stringify(req.body,null,4));
      req.call_method = 'post'
      req.call_params = [req.body]
      req.call_collection = req.params.dataType
    }
    next('route')
  },

  // Skip bodyParser.text if we already parsed the body for auth extraction
  function (req, res, next) {
    if (req._authBodyParsed) {
      // Body was already parsed for auth extraction, skip to processing
      req._body = true
      next()
    } else {
      // Let bodyParser.text handle it
      bodyParser.text({ type: 'application/x-www-form-urlencoded', limit: '30mb' })(req, res, next)
    }
  },
  function (req, res, next) {
    // debug('x-www-form-url-encoded check', body)
    req.call_method = 'query'
    req.call_collection = req.params.dataType
    var body = typeof req.body === 'string' ? querystring.parse(req.body) : req.body
    debug('BODY: ', body)
    if (body.rql) {
      req.call_params = [decodeURIComponent(body.rql)]
      req.queryType = 'rql'
    } else if (body.solr) {
      req.call_params = [decodeURIComponent(body.solr)]
      req.queryType = 'solr'
    } else {
      return next()
    }
    debug('CALL_PARAMS: ', req.call_params)
    next('route')
  },

  bodyParser.text({ type: 'application/rqlquery+x-www-form-urlencoded', limit: '30mb' }),
  bodyParser.text({ type: 'application/solrquery+x-www-form-urlencoded', limit: '30mb' }),
  function (req, res, next) {
    debug('Handle Form Body')
    // req.body=decodeURIComponent(req.body);
    // if (!req._body || !req.body) { debug(" No body to QUERY POST"); req.body="?keyword(*)"; } // next("route"); return }
    var ctype = req.get('content-type')
    req.call_method = 'query'
    req.call_params = req.body ? [req.body] : []
    req.call_collection = req.params.dataType
    req.queryType = (ctype === 'application/solrquery+x-www-form-urlencoded') ? 'solr' : 'rql'

    next()
  }
])

router.use([
  RQLQueryParser,
  // SOLRQueryParser, // this parses the solr query for errors, but doesn't make any chagnes to the stream.  Debugging only.
  DecorateQuery,
  Limiter,
  JoinFieldInjector,  // Inject join key fields into fl= before query execution
  DistributedQuery,  // Distributed query integration (after permission filters applied)
  ShardsPreference,
  function (req, res, next) {
    if (!req.call_method || !req.call_collection) {
      return next('route')
    }
    debug('req.call_method: ', req.call_method)
    debug('req.call_collection: ', req.call_collection)

    if (req.call_method === 'query') {
      debug('req.queryType: ', req.queryType)
    }
    next()
  },
  streamingHandler.checkIfStreaming,
  APIMethodHandler,
  reqCounter,
  ExtractCustomFields,
  ContentRange,
  JoinEnrichment,  // Enrichment joins for paginated queries (after ContentRange, before media)
  media
])

module.exports = router
