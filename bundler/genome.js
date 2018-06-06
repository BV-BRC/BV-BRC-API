var Defer = require('promised-io/promise').defer
var when = require('promised-io/promise').when
var debug = require('debug')('p3api-server:genomebundler')
var config = require('../config')
var request = require('request')
var distributeURL = config.get('distributeURL')
var publicGenomeDir = config.get('publicGenomeDir')
var Path = require('path')

const maxBundleSize = 25000

function runQuery (query, opts) {
  const def = new Defer()
  opts = opts || {}

  debug('Send Request to distributeURL: ', distributeURL + 'genome_feature')
  debug('runQuery: ', query)
  request.post({
    url: distributeURL + 'genome/',
    headers: {
      'content-type': 'application/rqlquery+x-www-form-urlencoded',
      accept: 'application/json',
      authorization: opts.token || ''
    },
    body: query
  }, function (err, r, body) {
    if (err) {
      return def.reject(err)
    }

    if (body && typeof body === 'string') {
      body = JSON.parse(body)
    }
    def.resolve(body)
  })

  return def.promise
}

module.exports = function (req, res, next) {
  const q = req.query + '&limit(' + maxBundleSize + ')&select(genome_id,public,owner,genome_name)'
  debug('GENOME BUNDLER. q: ', q)

  when(runQuery(q, {token: req.headers.authorization || ''}), function (genomes) {
    if (!genomes || genomes.length < 0) {
      return next('route')
    }
    const bulkMap = genomes.map(function (genome) {
      const map = {}
      if (genome.public) {
        map.expand = true
        map.cwd = publicGenomeDir
        map.dest = genome.genome_id
        map.src = []
        req.bundleTypes.forEach(function (bt) {
          map.src.push(genome.genome_id + bt)
        })
      } else {
        console.error('Processing of private genomes not yet supported')
        return false
      }

      return map
    }).filter(function (x) { return !!x })

    req.bulkMap = bulkMap
    next()
  }, function (err) {
    console.error('Error Retrieving Source Data for bundler: ', err)
    next(err)
  })
}
