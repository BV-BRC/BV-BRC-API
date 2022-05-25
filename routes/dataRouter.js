const express = require('express')
const config = require('../config')
const bodyParser = require('body-parser')
const router = express.Router({ strict: true, mergeParams: true })
const media = require('../middleware/media')
const RQLQueryParser = require('../middleware/RQLQueryParser')
const APIMethodHandler = require('../middleware/APIMethodHandler')
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
  'taxonomy': ['taxon_rank'],
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

router.get('/taxon_category/', [
  bodyParser.json({ extended: true }),
  // preset query params
  (req, res, next) => {
    const facetQuery = '&facet((field,superkingdom),(field,order),(field,family),(mincount,1))&limit(1)&json(nl,map)'
    req.queryType = 'rql'
    req.call_method = 'query'
    req.call_params = [req._parsedUrl.query + facetQuery]
    req.call_collection = 'genome'

    next()
  },
  RQLQueryParser,
  APIMethodHandler,
  // form return object
  (req, res, next) => {
    if (res.results && res.results.facet_counts && res.results.facet_counts.facet_fields) {
      const resp = res.results.facet_counts.facet_fields
      debug(resp)
      res.results = {
        'superkingdom': Object.keys(resp['superkingdom']),
        'order': Object.keys(resp['order']),
        'family': Object.keys(resp['family'])
      }
      next()
    } else {
      debug(res.results)
      res.status(400).send({ status: 400, message: 'Unable to query' })
    }
  },
  media
])

router.get('/subsystem_summary/:genome_id', [
  bodyParser.json({ extended: true }),
  cacheWithRedis('1 day', onlyStatus200),
  (req, res, next) => {
    const genome_id = req.params.genome_id
    const query = `q=*:*&fq=genome_id:${genome_id}&rows=0&facet=true&facet.limit=-1&facet.pivot.mincount=1&facet.pivot=superclass,class,subclass,subsystem_id`
    const sortByGeneCount = (a, b) => a.gene_count > b.gene_count ? -1 : 1

    subQuery('subsystem', query, {
      accept: 'application/solr+json'
    })
      .then((body) => {
        if (body && body.facet_counts && body.facet_counts.facet_pivot && body.facet_counts.facet_pivot) {
          const raw_data = body.facet_counts.facet_pivot['superclass,class,subclass,subsystem_id']
          const data = []
          // console.log(raw_data[2]) // superclass
          // console.log(raw_data[2].pivot[0]) // class
          // console.log(raw_data[2].pivot[0].pivot[0]) // subclass
          // console.log(raw_data[2].pivot[0].pivot[0].pivot[0]) // subsystems

          // superclass level
          raw_data.forEach((superclass) => {
            let superKlass_ss_count = 0
            const superKlassChildren = []

            // class level
            superclass['pivot'].forEach((klass) => {
              let Klass_ss_count = 0
              const KlassChildren = []

              // subclass level
              klass['pivot'].forEach((subclass) => {
                // final level, grouped by subsystem_id
                let subclass_ss_count = subclass.pivot.length

                const subKlass = {
                  'name': subclass.value,
                  'subsystem_count': subclass_ss_count,
                  'gene_count': subclass.count
                }
                KlassChildren.push(subKlass)
                Klass_ss_count += subclass_ss_count
              })
              const Klass = {
                'name': klass.value,
                'subsystem_count': Klass_ss_count,
                'gene_count': klass.count,
                'children': KlassChildren.sort(sortByGeneCount)
              }
              superKlassChildren.push(Klass)
              superKlass_ss_count += Klass_ss_count
            })
            const superKlass = { 'name': superclass.value,
              'subsystem_count': superKlass_ss_count,
              'gene_count': superclass.count,
              'children': superKlassChildren.sort(sortByGeneCount)
            }

            data.push(superKlass)
          })

          res.results = data.sort(sortByGeneCount)
          next()
        }
      }, (err) => {
        console.log(err)
        res.status(400).send({ status: 400, message: 'Unable to query' })
      })
  },
  (req, res, next) => {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = router
