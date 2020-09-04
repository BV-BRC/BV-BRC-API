const debug = require('debug')('p3api-server:cachemiddleware')
const Cache = require('../cache')
const Config = require('../config')
const Md5 = require('md5')
const isCacheEnabled = Config.get('cache').enable

module.exports.get = function (req, res, next) {
  if (!isCacheEnabled) { return next() }
  const key = [req.call_method, req.call_collection, req.queryType, req.call_params[0]]
  if (req.call_method === 'stream') { return next() }

  req.cacheKey = Md5(key.join())
  debug('Cache Req User: ', req.user)

  debug('Cache Key: ', req.cacheKey, key)
  const opts = {}
  if (req.user) {
    opts.user = req.user.id || req.user
  }

  res.queryStart = new Date()
  Cache.get(req.cacheKey, opts).then(function (data) {
    req.cacheHit = true
    res.results = data
    debug('CACHE HIT: ', req.cacheKey)
    next()
  }, function (err) {
    if (err) {
      debug('CACHE MISSED ERROR: ', err)
    } else {
      debug('CACHE MISS')
    }
    next()
  })
}

module.exports.put = function (req, res, next) {
  if (!req.cacheHit && req.cacheKey) {
    const opts = {}
    if (req.user) {
      opts.user = req.user.id || req.user
    }
    debug('Store Cached Data: ', req.cacheKey)
    Cache.put(req.cacheKey, res.results, opts)
  }

  next()
}
