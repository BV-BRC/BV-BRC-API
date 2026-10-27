#!/usr/bin/env node --unhandled-rejections=strict

var config = require('./config')
var debug = require('debug')('p3api-server:app')
var express = require('express')
var path = require('path')
var logger = require('morgan')
var cookieParser = require('cookie-parser')
var hpiSearchRouter = require('./routes/hpiSearch')
var dataTypeRouter = require('./routes/dataType')
var downloadRouter = require('./routes/download')
var multiQueryRouter = require('./routes/multiQuery')
var contentRouter = require('./routes/content')
var rpcHandler = require('./routes/rpcHandler')
var jbrowseRouter = require('./routes/JBrowse')
var genomePermissionRouter = require('./routes/genomePermissionRouter')
var dataRouter = require('./routes/dataRouter')
var indexer = require('./routes/indexer')
var docRouter = require('./routes/documentation')
var indexRouter = require('./routes/index')
var distributedQueryRouter = require('./routes/distributedQueryRouter')
var pkgJSON = require("./package.json");
var sleep = require("sleep-promise");


var cors = require('cors')
var corsOptions = require('./util/corsOptions')
var crypto = require('crypto')
const { getAgentStats, totalQueued } = require('./lib/agentStats')
const { getAdmissionStats } = require('./middleware/QueryClassifier')

// Generate request ID for all requests (used for log correlation)
function generateRequestId () {
  return 'p3api-' + crypto.randomBytes(6).toString('hex')
}

process.on('uncaughtException', (err, origin) => {
  console.log(`Uncaught Expcetion. [${(new Date()).toISOString()}] ${err}, ${origin}`)
})
process.on('unhandledRejection', (reason, promise) => {
  console.log(`UnhandledRejection. [${(new Date()).toISOString()}] reason: ${reason}, promise:`, promise)
})

var app = module.exports = express()
process.send = process.send || function(){}
const listener  = app.listen(config.get('http_port') || 3001, function(){
  console.log(`Listening on port ${listener.address().port}`)
	  process.send("ready")
})

var draining = false;
var stats = {
  active_requests: 0
}


// view engine setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

app.enable('etag')
app.set('etag', 'strong')

logger.token('qtime', function (req, res) {
  var from = 'QUERY '
  if (req.cacheHit) {
    from = 'CACHE '
  }

  if (!res.formatStart || !res.queryStart) {
    return ''
  }

  return from + (res.formatStart.valueOf() - res.queryStart.valueOf())
})
logger.token('remote-ip', function (req, res) {
  return req.headers['x-forwarded-for'] || req.connection.remoteAddress
})
logger.token('auth-user', function (req, res) {
  return req.authUser || '<unauth>'
})

logger.token('request-id', function (req, res) {
  // Use X-Request-ID from nginx if available, or requestId set by Limiter middleware
  return req.headers['x-request-id'] || req.requestId || '-'
})

app.use(logger('[:date[iso]] :remote-ip :method :url :status :response-time [:qtime] ms - :res[content-length] :auth-user rid=:request-id'))

// Set request ID early for all requests (before other middleware)
app.use(function (req, res, next) {
  // Use X-Request-ID from nginx if available, otherwise generate one
  req.requestId = req.headers['x-request-id'] || generateRequestId()
  next()
})

app.use(function (req, res, next) {
  debug('APP MODE: ', app.get('env'))
  req.production = (app.get('env') === 'production')
  next()
})

app.use((req,res,next)=>{
	if (draining){
		res.status(503)
		res.send("Draining")
		res.end()
		return;
	}

	function fn(){
		stats.active_requests--
		res.removeListener("finish",fn)
	}
	stats.active_requests = stats.active_requests + 1
	res.on("finish", fn)
	next()
});


app.use(cookieParser())

// Security headers to prevent XSS
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'none'; object-src 'none'")
  next()
})

// See util/corsOptions.js. The previous inline configuration misspelled two
// keys (credential/allowHeaders), so credentials never worked and the header
// list was silently replaced by reflection of whatever the browser asked for.
app.use(cors(corsOptions(config)))

var collections = config.get('collections')

app.use('/indexer', indexer)

app.get('/', indexRouter)
app.use('/doc', docRouter)
app.post('/', rpcHandler)
app.use('/resources', express.static('public'))
app.use('/health', function (req, res, next) {
  res.write(`OK (${pkgJSON.version})`)
  res.end()
})

// Operational stats.
//
// `active_requests` is preserved verbatim at the top level — it is the field existing
// monitoring reads, and the hang investigation used it to diagnose socket exhaustion.
// Everything new is additive, under its own keys, so no consumer breaks.
//
// `agents` is the part that was missing. maxSockets caps concurrency, not queue depth,
// and Node's http.Agent has no queue cap at all, so requests waiting for a socket
// accumulate invisibly. `agents.<name>.queued` is that number. Phase 2 of
// Docs/COMPLETION_PLAN-2026-10.md sizes admission pools on the rule "admission pool <=
// socket pool, so the socket queue stays empty" — which is unverifiable without this.
app.use('/stats', function (req, res, next) {
  let payload
  try {
    payload = {
      ...stats,
      uptime_s: Math.round(process.uptime()),
      pid: process.pid,
      agents: getAgentStats(),
      sockets_queued_total: totalQueued(),
      // Admission pool state. Reported even while admission is disabled, so a dry run
      // shows what would have been shed before enforcement is turned on — and so the
      // pool sizes can be tuned against real numbers rather than guesses.
      admission: getAdmissionStats()
    }
  } catch (err) {
    // A stats endpoint that 500s during an incident is worse than one returning a
    // partial answer, so fall back to the original payload rather than throwing.
    console.error(`/stats: failed to collect extended stats: ${err && err.message}`)
    payload = stats || {}
  }
  res.setHeader('Content-Type', 'application/json')
  res.write(JSON.stringify(payload))
  res.end()
})

app.use('/content', [
  contentRouter
])

app.use('/testTimeout', function (req, res, next) {
  setTimeout(function () {
    res.send('OK')
    res.end()
  }, 60 * 1000 * 5)
})

app.use('/jbrowse/', [
  jbrowseRouter
])

app.use('/query', [
  multiQueryRouter
])

app.use('/hpi/search', [
  hpiSearchRouter
])

app.use('/data', [
  dataRouter
])

app.param('dataType', function (req, res, next, dataType) {
  if (collections.indexOf(dataType) !== -1) {
    next()
    return
  }
  next('route')
})

app.use('/bundle/:dataType/', [
  downloadRouter
])

app.use('/permissions/genome', [
  genomePermissionRouter
])

app.use('/test/distributed-query', [
  distributedQueryRouter
])

app.use('/:dataType/', [
  dataTypeRouter
])

// Send 404
app.use(function (req, res, next) {
  console.error(`Unable to find router.`, req)
  res.setHeader('Content-Type', 'application/json')
  res.status(404)
  res.send({
    'status': 404,
    'message': 'Not Found'
  })
  res.end()
})

/*
 * Error fields safe to return to a client, copied onto the JSON body when present.
 *
 * ALLOWLIST, deliberately. An Error picked up by the terminal handler may carry a stack,
 * a Solr response fragment, or the caller's own filter text; serialising it wholesale is
 * how internal detail escapes. Add a field here only after deciding it is safe to publish.
 *
 * Current members, all from JoinTooBroadError (lib/joinResolver.js) — they let a UI say
 * "Viruses holds 14.9 million genomes, more than this view can summarise" and offer the
 * child taxa, instead of printing a sentence it had to regex:
 *
 *   genomeCount  how many genomes the join matched
 *   limit        the threshold it exceeded (config, so do NOT hardcode it client-side)
 *   taxonId      the taxon at fault, when the filter was purely taxonomic
 *
 * `filter` is deliberately NOT here: it is raw Solr the client never wrote and has no use
 * for, and echoing query internals back is the habit that produces disclosure bugs.
 */
const ERROR_DETAIL_FIELDS = ['genomeCount', 'limit', 'taxonId']

// Handle errors
app.use(function (error, req, res, next) {
  // If the response has already started (e.g. a streaming/distributed download
  // that failed mid-stream), we cannot change status or set headers. Setting a
  // header here throws ERR_HTTP_HEADERS_SENT; instead abort the socket so the
  // client sees a truncated/failed transfer rather than a silent 200.
  if (res.headersSent) {
    console.error(`Error after headers sent (${req.method} ${req.originalUrl}): ${error && error.message}`)
    // Abort the socket with NO error argument. Passing the error re-emits it on
    // res, producing a secondary "socket hang up" uncaughtException; we only want
    // to sever the connection so the client sees a truncated transfer.
    try { res.destroy() } catch (e) { /* already torn down */ }
    return
  }
  res.setHeader('Content-Type', 'application/json')

  // Propagate Retry-After on a 429 regardless of which layer produced it.
  //
  // middleware/QueryClassifier sets this header itself for an admission rejection, but a
  // 429 originating at Solr — a circuit breaker or the request rate limiter tripping —
  // arrives here as a SolrHttpError carrying `retryAfterMs` parsed from Solr's own
  // response, and nothing was writing it out. A bare 429 with no guidance is exactly what
  // provokes the tight retry loop that admission control exists to prevent, and it does
  // the most damage precisely when Solr is already in trouble. See Docs/CLIENT-429.md.
  if ((error.status === 429 || error.status === 503) && !res.getHeader('Retry-After')) {
    const ms = error.retryAfterMs
    const secs = typeof ms === 'number' && ms >= 0
      ? Math.max(1, Math.ceil(ms / 1000))
      : (error.retryAfterSeconds || 1)
    res.setHeader('Retry-After', String(secs))
  }

  // Structured error detail, for clients that want to react rather than just display.
  //
  // `message` stays exactly as it was — it is the human-readable text, several clients
  // show it verbatim, and nothing about it changes here. The extra fields are ADDITIVE:
  // a client that ignores them sees the same body it always did.
  //
  // Only an explicit allowlist is copied. An error object carries whatever the throwing
  // code attached — stack frames, Solr response fragments, the user's own filter — and
  // blanket-serialising that is how internal detail leaks to clients. Anything new has to
  // be added here deliberately.
  const body = {
    status: error.status || 500,
    message: error.message || 'Interal Server Error'
  }
  if (error.errorCode) {
    // A stable machine-readable tag. Clients should branch on this, never on the prose.
    body.error = error.errorCode
  }
  for (const field of ERROR_DETAIL_FIELDS) {
    if (error[field] !== undefined) {
      body[field] = error[field]
    }
  }

  res.status(error.status || 500)
  res.send(body)
})
