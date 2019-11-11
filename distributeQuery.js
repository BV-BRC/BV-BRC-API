var Defer = require('promised-io/promise').defer
var debug = require('debug')('p3api-server:distributeQuery')
var config = require('./config')
var request = require('request')
var distributeURL = config.get('distributeURL')

module.exports = function query (dataType, query, opts) {
  debug('Query: ', query)
  var def = new Defer()
  opts = opts || {}

  debug('Send Request to distributeURL: ', distributeURL + dataType)
  debug('runQuery: ', dataType, query, opts)
  request.post({
    url: distributeURL + dataType + '/',
    headers: {
      'content-type': 'application/rqlquery+x-www-form-urlencoded',
      accept: opts.accept || 'application/json',
      authorization: opts.authorization || ''
    },
    body: query
  }, function (err, r, body) {
    // debug("Distribute RESULTS: ", body);
    debug('r.headers: ', r.headers)
    if (err) {
      return def.reject(err)
    }

    if (body && typeof body === 'string') {
      try {
        body = JSON.parse(body)
      }catch(err){
        return def.reject(new Error("Unable to parse response from distributed query: " + err));
      }
    }
    def.resolve(body)
  })

  return def.promise
}
