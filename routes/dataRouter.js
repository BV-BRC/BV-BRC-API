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
const onlyStatus200 = (req, res) => res.statusCode === 200

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
  cacheWithRedis('1 day', onlyStatus200),
  bodyParser.json({ extended: true }),
  function (req, res, next) {
    const defs = []
    res.results = {}

    debug('summary_by_taxon:', req.params.taxon_id)

    defs.push(
      subQuery(
        'genome',
        `q=*:*&fq=taxon_lineage_ids:${req.params.taxon_id}&rows=0&json.facet={unique_family:"unique(family)",unique_genus:"unique(genus)",unique_species:"unique(species)"}`,
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
        `q=*:*&fq=feature_type:(CDS OR mat_peptide)&fq={!join fromIndex=genome from=genome_id to=genome_id v=taxon_lineage_ids:${req.params.taxon_id}}&rows=0&facet=true&facet.field=feature_type&facet.mincount=1&json.nl=map`,
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
    defs.push(
      subQuery(
        'strain',
        `q=*:*&fq=taxon_lineage_ids:${req.params.taxon_id}&rows=0`,
        {
          accept: 'application/solr+json'
        }
      ).then((results) => {
        const counts = {
          'strains_count': results.response.numFound
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
    // post process, delete when count is 1
    if (res.results['unique_family'] === 1) {
      delete res.results['unique_family']
    }
    if (res.results['unique_genus'] === 1) {
      delete res.results['unique_genus']
    }
    if (res.results['unique_species'] === 1) {
      delete res.results['unique_species']
    }
    next()
  },
  function (req, res, next) {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])
const allowed = {
  'epitope': ['epitope_type'],
  'genome': ['host_group', 'host_name', 'host_common_name', 'geographic_group', 'isolation_country', 'segment', 'subtype', 'season', 'lineage'],
  'genome_feature': ['feature_type'],
  'sp_gene': ['property', 'source', 'evidence'],
  'pathway_ref': ['pathway_name', 'pathway_class'],
  'subsystem_ref': ['subsystem_id', 'subsystem_name'],
  'protein_feature': ['source'],
  'protein_structure': ['method'],
  'surveillance': ['pathogen_test_type', 'pathogen_test_result', 'subtype', 'host_group', 'host_common_name', 'host_species', 'geographic_group', 'collection_country'],
  'serology': ['test_type', 'test_result', 'serotype', 'host_type', 'host_common_name', 'host_species', 'geographic_group', 'collection_country']
}

router.get('/distinct/:collection/:field', [
  bodyParser.json({ extended: true }),
  (req, res, next) => {
    const collection = req.params.collection
    const field = req.params.field
    if (allowed.hasOwnProperty(collection) && allowed[collection].includes(field)) {
      next()
    } else {
      res.set('content-type', 'application/json')
      res.end(JSON.stringify({ status: 405, message: `/distinct/${collection}/${field} is not allowed` }))
    }
  },
  cacheWithRedis('1 day', onlyStatus200),
  (req, res, next) => {
    const collection = req.params.collection
    const field = req.params.field

    subQuery(collection, `q=*:*&rows=0&facet=true&facet.field=${field}&facet.mincount=1&facet.limit=-1&json.nl=map`, {
      accept: 'application/solr+json'
    })
      .then((body) => {
        if (body && body.facet_counts) {
          // debug(body.facet_counts.facet_fields[field])
          res.results = body.facet_counts.facet_fields[field]
          next()
        } else {
          next({ 'status': body.status, 'message': body.error.msg })
        }
      })
  },
  (req, res) => {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = router
