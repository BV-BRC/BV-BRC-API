const FS = require('fs')

const models = {}

FS.readdirSync(__dirname).filter((filename) => {
  return filename.match('.js$') && (filename !== 'index.js')
}).forEach((filename) => {
  const name = filename.replace('.js', '')
  const model = require('./' + name)
  models[model.contentType] = model.serialize
  if (name == 'json') {
    models['*/*'] = model.serialize
    models['default'] = model.serialize
  }
})
module.exports = models
