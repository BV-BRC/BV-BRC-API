const BodyParser = require('body-parser')
const RpcMethods = require('../rpc')
const debug = require('debug')('p3api-server:route/rpcHandler')

module.exports = [
  BodyParser.json({type: ['application/jsonrpc+json'], limit: '30mb'}),
  BodyParser.json({type: ['application/json'], limit: '30mb'}),
  function (req, res, next) {
    if (!req.body) {
      next()
      return
    }
    const ctype = req.get('content-type')

    if (req.body.jsonrpc || (ctype === 'application/jsonrpc+json')) {
      if (!req.body.method) {
        throw Error('No Method Supplied')
      }

      const methodDef = RpcMethods[req.body.method]
      if (!methodDef) {
        throw Error(`Invalid Method: ${req.body.method}`)
      }

      if (methodDef.requireAuth && !req.user) {
        res.status(401)
        throw Error('Authentication Required')
      }

      if (!methodDef.validate || !methodDef.validate(req.body.params, req, res)) {
        throw Error(`RPC Parameter Validation Failed: ${req.body.params}`)
      }

      req.call_method = req.body.method
      req.call_params = req.body.params
      next()
    } else {
      next('route')
    }
  },
  function (req, res, next) {
    RpcMethods[req.call_method].execute(req.call_params, req, res).then((results) => {
      res.results = results
      next()
    }, function (err) {
      debug('Got Execute Error: ', err)
      res.error = err
      next()
    })
  },

  function (req, res, next) {
    var out = {}
    out.id = req.body.id || 0
    if (res.error) {
      out.error = res.error.toString()
    } else {
      out.result = res.results
    }

    res.write(JSON.stringify(out))
    res.end()
  }
]
