var express = require('express')
var router = express.Router({strict: true, mergeParams: true})
var when = require('promised-io/promise').when
var All = require('promised-io/promise').all
var bodyParser = require('body-parser')
var debug = require('debug')('p3api-server:route/multiQuery')
var httpParams = require('../middleware/http-params')
var authMiddleware = require('../middleware/auth')
var distributeQuery = require('../distributeQuery')

router.use(httpParams)
router.use(authMiddleware)

router.post('*', [
  bodyParser.json({extended: true}),
  function (req, res, next) {
    debug('req.body: ', req.body)
    var defs = []
    res.results = {}

    Object.keys(req.body).forEach(function (qlabel) {
      var qobj = req.body[qlabel]
      res.results[qlabel] = {}

      defs.push(when(distributeQuery(qobj.dataType, qobj.query, {
        accept: qobj.accept,
        authorization: (req.headers && req.headers['authorization']) ? req.headers['authorization'] : ''
      }), function (result) {
        debug('RES: ', qlabel, result)
        res.results[qlabel].result = result
      }))
    })

    when(All(defs), function () {
      next()
    }, function(err){
      next(err);
    })
  },

  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = router
