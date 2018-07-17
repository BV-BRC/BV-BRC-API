// const debug = require('debug')('p3api-server:utils/md5Lookup')
const Defer = require('promised-io/promise').defer
const Request = require('request')
const config = require('../config')
const distributeURL = config.get('distributeURL')

function getSequenceByHash (md5) {
  const def = new Defer()

  Request.get(`${distributeURL}feature_sequence/${md5}`, {
    headers: {
      'Accept': 'application/json'
    },
    json: true
  }, function (error, resp, body) {
    if (error) {
      def.reject(error)
    }

    def.resolve(body.sequence)
  })
  return def.promise
}

module.exports = getSequenceByHash
