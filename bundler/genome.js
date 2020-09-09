// const debug = require('debug')('p3api-server:genomebundler')
const Config = require('../config')
const PUBLIC_GENOME_DIR = Config.get('publicGenomeDir')
const { httpRequest } = require('../util/http')

const maxBundleSize = 25000

function runQuery (query, opts) {
  return httpRequest({
    port: Config.get('http_port'),
    path: '/genome/',
    headers: {
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      accept: 'application/json',
      authorization: opts.token
    },
    method: 'POST'
  }, query)
    .then((body) => JSON.parse(body))
}

module.exports = function (req, res, next) {
  const query = `${req.query}&limit(${maxBundleSize})&select(genome_id,public,owner,genome_name)`

  runQuery(query, { token: req.headers.authorization || '' }).then((genomes) => {
    if (!genomes || genomes.length < 0) {
      return next('route')
    }
    const bulkMap = genomes.map(function (genome) {
      const map = {}
      if (genome.public) {
        map.expand = true
        map.cwd = PUBLIC_GENOME_DIR
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
