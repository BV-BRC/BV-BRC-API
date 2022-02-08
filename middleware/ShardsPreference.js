const debug = require('debug')('ShardsPreference')
const Config = require('../config')
const ShardsConfig = Config.get('shards')

module.exports = function (req, res, next) {
  // shards.preference=replica.type:PULL
  const collection = req.call_collection

  if (ShardsConfig[collection] && req.call_method === 'query') {
    const param = `&shards.preference=${ShardsConfig[collection].preference}`
    req.call_params[0] = req.call_params[0] + param
    debug(req.call_params[0])
  }
  next()
}
