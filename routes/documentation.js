var express = require('express')
var router = express.Router()
const config = require('../config')
const APIMethodHandler = require('../middleware/APIMethodHandler')
const documentation_data = require('./documentation_data.json')

var baseURL = config.get('publicURL')
if (baseURL[baseURL.length - 1] === '/') {
  baseURL = baseURL.substring(0, baseURL.length - 1)
}

const render_type = (field, schema) => {
  var out

  switch (field.type) {
    case 'pdouble':
    case 'pfloat':
    case 'plong':
    case 'double':
    case 'float':
    case 'long':
      out = 'number'
      break
    case 'pdoubles':
    case 'pfloats':
      out = 'array of numbers'
      break
    case 'boolean':
      out = 'boolean'
      break
    case 'booleans':
      out = 'array of booleans'
      break
    case 'int':
      out = 'integer'
      break
    case 'pints':
      out = 'array of integers'
      break
    case 'string_ci':
      out = 'case insensitive string'
      break
    case 'pdate':
      out = 'date'
      break
    case 'pdates':
      out = 'array of dates'
      break
    case 'text_custom':
    case 'string':
      out = 'string'
      break
    case 'text_general':
    case 'strings':
      out = 'array of strings'
      break
  }
  if (field.multiValued && !out.match(/array/i)) {
    out = `array of ${out}s`
  }
  return out
}

/* DOCs home page. */
router.get('/', function (req, res) {
  res.render('documentation_home', { results: [], baseURL: baseURL, doc_data: documentation_data, config: config, request: req, title: 'Documentation Home' })
})

router.get('/:collection', [
  function (req, res, next) {
    req.call_collection = req.params.collection
    req.call_method = 'schema'
    next()
  },
  APIMethodHandler,
  function (req, res) {
    if (res.results && res.results.schema) {
      res.render('documentation_collection', { results: res.results, baseURL: baseURL, default_query_formatters: documentation_data.default_query_formatters, specialized_result_formatters: documentation_data.specialized_result_formatters || false, doc_data: documentation_data.collections[req.params.collection] ? documentation_data.collections[req.params.collection] : {}, collection: req.params.collection, render_type: render_type, config: config, request: req, title: `Documentation: ${req.params.collection}` })
    } else {
      res.render('documentation_collection_missing', { doc_data: documentation_data.collections[req.params.collection] ? documentation_data.collections[req.params.collection] : {}, collection: req.params.collection, config: config, request: req, title: `Documentation: ${req.params.collection}` })
    }
  }
])

module.exports = router
