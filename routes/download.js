var express = require('express')
var router = express.Router({strict: true, mergeParams: true})
var defer = require('promised-io/promise').defer
var when = require('promised-io/promise').when
var config = require('../config')
var bodyParser = require('body-parser')
var debug = require('debug')('p3api-server:route/download')
var httpParams = require('../middleware/http-params')
var authMiddleware = require('../middleware/auth')
var querystring = require('querystring')
var archiver = require('archiver')
var path = require('path')

router.use(httpParams)
router.use(authMiddleware)

router.get('*', [
  function (req, res, next) {
    var url = req.url
    if (url.match(/^\/\?/)) {
      url = url.replace(/^\/\?/, '')
    }
    var query = querystring.parse(url)
    debug('QUERY PARSE: ', query)
    if (query.types) {
      req.bundleTypes = query.types.split(',') || []
    } else {
      req.bundleTypes = []
    }

    if (query.query || query.q) {
      req.query = query.query || query.q
    }

    if (query.archiveType) {
      req.archiveType = query.archiveType
    }

    req.sourceDataType = req.params.dataType

    next()
  }
])

router.post('*', [
  bodyParser.urlencoded({extended: true}),
  function (req, res, next) {
    debug('req.body: ', req.body)

    if (req.body.types) {
      req.bundleTypes = req.body.types.split(',') || []
    } else {
      req.bundleTypes = []
    }

    if (req.body.query || req.body.q) {
      req.query = req.body.query || req.body.q
    }

    if (req.body.archiveType) {
      req.archiveType = req.body.archiveType
    }

    req.sourceDataType = req.params.dataType
    next()
  }
])

router.use(function (req, res, next) {
  debug('req content-type', req.get('content-type'))
  debug('req.query', req.query)
  debug('req.bundleTypes', req.bundleTypes)
  debug('req.sourceDataType: ', req.sourceDataType)
  next()
})

router.use([
  function (req, res, next) {
    if (!req.sourceDataType) {
      return next(new Error('Source Data Type Missing'))
    }

    if (!req.query) {
      return next(new Error('Missing Source Query'))
    }

    if (!req.bundleTypes || req.bundleTypes.length < 1) {
      res.writeHead(400, {'Content-Type': 'text/plain'})
      res.end('Missing Bundled Types')
      return
    }

    if (req.archiveType) {
    }

    next()
  },
  function (req, res, next) {
    debug('Load Bundler for: ', req.sourceDataType)
    var bundler
    try {
      bundler = require('../bundler/' + req.sourceDataType)
      // debug("Bundler: ", bundler)
      bundler(req, res, next)
    } catch (err) {
      return next(new Error('Invalid Source Data Type' + err))
    }
  },
  function (req, res, next) {
    // debug("Bundler Map: ", req.bulkMap)
    if (!req.bulkMap) {
      debug('No Bulk Map Found')
      next('route')
    }

    var archOpts = {}
    var type

    if (req.archiveType) {
      type = req.archiveType
    } else {
      switch (req.headers.accept) {
        case 'application/x-tar':
          type = 'tar'
          break
        case 'application/x-zip':
        default:
          type = 'zip'
      }
    }

    if (type == 'tar') {
      archOpts.gzip = true
      res.attachment('PATRIC_Export.tgz')
    } else if (type == 'zip') {
      res.attachment('PATRIC_Export.zip')
    }

    var archive = archiver.create(type, archOpts)
    archive.pipe(res)
    for (var i = 0; i < req.bulkMap.length; i++) {
      const baseFolder = req.bulkMap[i].cwd
      const dest = req.bulkMap[i].dest
      for (var j = 0; j < req.bulkMap[i].src.length; j++) {
        const fileName = req.bulkMap[i].src[j]
        const filePath = path.join(dest, fileName)
        // console.log(`adding ${filePath}`)
        archive.glob(filePath, { cwd: baseFolder })
      }
    }
    archive.finalize()
  }
])

module.exports = router
