const express = require('express')
const config = require('../config')
const bodyParser = require('body-parser')
const router = express.Router({ strict: true, mergeParams: true })
const httpParams = require('../middleware/http-params')
const { httpRequest } = require('../util/http')
const debug = require('debug')('p3api-server:route/summary')
const apicache = require('apicache')
const redis = require('redis')
const redisOptions = config.get('redis')

const cacheWithRedis = apicache.options({ redisClient: redis.createClient(redisOptions) }).middleware

router.use(httpParams)

async function subQuery (dataType, query, opts) {
  return httpRequest({
    port: config.get('http_port'),
    headers: {
      'Content-Type': 'application/solrquery+x-www-form-urlencoded',
      Accept: opts.accept || 'application/json',
      Authorization: ''
    },
    method: 'POST',
    path: `/${dataType}`
  }, query)
    .then((body) => {
      return JSON.parse(body)
    })
}

router.get('/summary_by_taxon/:taxon_id', [
  cacheWithRedis('1 day'),
  bodyParser.json({ extended: true }),
  function (req, res, next) {
    const defs = []
    res.results = {}

    debug('summary_by_taxon:', req.params.taxon_id)

    defs.push(
      subQuery(
        'genome',
        `q=*:*&fq=taxon_lineage_ids:${req.params.taxon_id}&rows=0&json.facet={unique_family:"unique(family)",unique_genus:"unique(genus)",unique_species:"unique(species)",unique_strain:"unique(strain)"}`,
        {
          accept: 'application/solr+json'
        }
      ).then((results) => {
        res.results = Object.assign(res.results, results.facets)
      })
    )
    defs.push(
      subQuery(
        'genome_feature',
        `q=*:*&fq=feature_type:(CDS OR mat_peptide)&fq={!join fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:${req.params.taxon_id}&rows=0&facet=true&facet.field=feature_type&facet.mincount=1&json.nl=map`,
        {
          accept: 'application/solr+json'
        }
      ).then((results) => {
        const feature_type_count = results.facet_counts.facet_fields.feature_type
        res.results = Object.assign(res.results, feature_type_count)
      })
    )
    defs.push(
      subQuery(
        'protein_structure',
        `q=*:*&fq=taxon_lineage_ids:${req.params.taxon_id}&rows=0`,
        {
          accept: 'application/solr+json'
        }
      ).then((results) => {
        const counts = {
          'PDB': results.response.numFound
        }
        res.results = Object.assign(res.results, counts)
      })
    )

    Promise.all(defs).then(() => {
      next()
    }, (err) => {
      next(err)
    })
  },
  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = router
