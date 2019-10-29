var fs = require('fs-extra')
var debug = require('debug')('p3api-server:media/index')
// var Path = require("path");

var models = {}

fs.readdirSync(__dirname).filter(function (filename) {
  return filename.match('.js$') && (filename !== 'index.js')
}).forEach(function (filename) {
  var name = filename.replace('.js', '')
  debug('Loading Media Serializer: ' + './' + name + ' from ' + filename)
  var m = require('./' + name)
  models[m.contentType] = m.serialize
})

module.exports = models
