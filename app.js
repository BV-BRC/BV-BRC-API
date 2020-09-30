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
var indexer = require('./routes/indexer')
var cors = require('cors')

process.on('uncaughtException', (err, origin) => {
  console.log(`Uncaught Expcetion. [${(new Date()).toISOString()}] ${err}, ${origin}`)
})
process.on('unhandledRejection', (reason, promise) => {
  console.log(`UnhandledRejection. [${(new Date()).toISOString()}] reason: ${reason}, promise:`, promise)
})

var app = module.exports = express()
app.listen(config.get('http_port') || 3001)

// view engine setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

app.enable('etag')
app.set('etag', 'strong')

var stats = null

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

app.use(logger('[:date[iso]] :remote-ip :method :url :status :response-time [:qtime] ms - :res[content-length]'))

app.use(function (req, res, next) {
  debug('APP MODE: ', app.get('env'))
  req.production = (app.get('env') === 'production')
  next()
})

app.use(cookieParser())

app.use(cors({
  origin: true,
  methods: ['GET,POST,PUT,DELETE'],
  allowHeaders: ['if-none-match', 'range', 'accept', 'x-range', 'content-type', 'authorization'],
  exposedHeaders: ['facet_counts', 'x-facet-count', 'Content-Range', 'X-Content-Range', 'ETag'],
  credential: true,
  maxAge: 8200
}))

var collections = config.get('collections')

app.use('/indexer', indexer)

app.post('/', rpcHandler)

app.use('/health', function (req, res, next) {
  res.write('OK')
  res.end()
})

app.use('/stats', function (req, res, next) {
  if (stats) {
    res.write(JSON.stringify(stats))
  } else {
    res.write('{}')
  }
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

// Handle errors
app.use(function (error, req, res, next) {
  res.setHeader('Content-Type', 'application/json')
  res.status(error.status || 500)
  res.send({
    status: error.status || 500,
    message: error.message || 'Interal Server Error'
  })
})
