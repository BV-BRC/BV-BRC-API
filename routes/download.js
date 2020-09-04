const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const BodyParser = require('body-parser')
const debug = require('debug')('p3api-server:route/download')
const HttpParamsMiddleWare = require('../middleware/http-params')
const AuthMiddleware = require('../middleware/auth')
const QueryString = require('querystring')
const Archiver = require('archiver')
const Path = require('path')

Router.use(HttpParamsMiddleWare)
Router.use(AuthMiddleware)

Router.get('*', [
  function (req, res, next) {
    let url = req.url
    if (url.match(/^\/\?/)) {
      url = url.replace(/^\/\?/, '')
    }
    const query = QueryString.parse(url)
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

Router.post('*', [
  BodyParser.urlencoded({ extended: true }),
  function (req, res, next) {
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

Router.use(function (req, res, next) {
  debug(`req.content-type: ${req.get('content-type')}`)
  debug(`req.query: ${req.query}`)
  debug(`req.bundleTypes: ${req.bundleTypes}`)
  debug(`req.archiveType: ${req.archiveType}`)
  next()
})

Router.use([
  function (req, res, next) {
    if (!req.sourceDataType) {
      return next(new Error('Source Data Type Missing'))
    }

    if (!req.query) {
      return next(new Error('Missing Source Query'))
    }

    if (!req.bundleTypes || req.bundleTypes.length < 1) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing Bundled Types')
      return
    }

    next()
  },
  function (req, res, next) {
    try {
      const bundler = require('../bundler/' + req.sourceDataType)
      bundler(req, res, next)
    } catch (err) {
      return next(new Error(`Invalid Source Data Type ${err}`))
    }
  },
  function (req, res, next) {
    if (!req.bulkMap) {
      next('route')
    }

    const archOpts = {}
    let type

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

    if (type === 'tar') {
      archOpts.gzip = true
      res.attachment('PATRIC_Export.tgz')
    } else if (type === 'zip') {
      res.attachment('PATRIC_Export.zip')
    }

    const archive = Archiver.create(type, archOpts)
    archive.pipe(res)
    for (let i = 0; i < req.bulkMap.length; i++) {
      const baseFolder = req.bulkMap[i].cwd
      const dest = req.bulkMap[i].dest
      for (let j = 0; j < req.bulkMap[i].src.length; j++) {
        const fileName = req.bulkMap[i].src[j]
        const filePath = Path.join(dest, fileName)

        archive.glob(filePath, { cwd: baseFolder })
      }
    }
    archive.finalize()
  }
])

module.exports = Router
