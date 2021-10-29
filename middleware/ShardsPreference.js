const debug = require('debug')('ShardsPreference')
const Config = require('../config')
const ShardsPreference = Config.get('shards').preference

module.exports = function (req, res, next) {
  // shards.preference=replica.type:PULL
  if (ShardsPreference) {
    const param = `&shards.preference=${ShardsPreference}`
    req.call_params[0] = req.call_params[0] + param
    debug(req.call_params[0])
  }
  next()
}
