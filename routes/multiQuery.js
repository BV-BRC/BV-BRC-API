const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const BodyParser = require('body-parser')
const debug = require('debug')('p3api-server:route/multiQuery')
const HttpParamsMiddleware = require('../middleware/http-params')
const AuthMiddleware = require('../middleware/auth')
const { httpRequest } = require('../util/http')
const Config = require('../config')

async function subQuery (dataType, query, opts) {
  return httpRequest({
    port: Config.get('http_port'),
    headers: {
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      Accept: opts.accept || 'application/json',
      Authorization: opts.authorization || ''
    },
    method: 'POST',
    path: `/${dataType}`
  }, query)
    .then((body) => JSON.parse(body))
}

Router.use(HttpParamsMiddleware)
Router.use(AuthMiddleware)

Router.post('*', [
  BodyParser.json({ extended: true }),
  function (req, res, next) {
    debug('req.body: ', req.body)
    const defs = []
    res.results = {}

    Object.keys(req.body).forEach(function (qlabel) {
      var qobj = req.body[qlabel]
      res.results[qlabel] = {}

      defs.push(subQuery(qobj.dataType, qobj.query, {
        accept: qobj.accept,
        authorization: (req.headers && req.headers['authorization']) ? req.headers['authorization'] : ''
      }).then(function (result) {
        debug('RES: ', qlabel, result.length)
        res.results[qlabel].result = result
      }))
    })

    Promise.all(defs).then(() => {
      next()
    }, (err) => {
      next(err)
    })
  },

  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = Router
