const express = require('express')
const config = require('../config')
const bodyParser = require('body-parser')
const router = express.Router({ strict: true, mergeParams: true })
const media = require('../middleware/media')
const RQLQueryParser = require('../middleware/RQLQueryParser')
const APIMethodHandler = require('../middleware/APIMethodHandler')
const httpParams = require('../middleware/http-params')
const { internalQuery } = require('../lib/internalQuery')
const debug = require('debug')('p3api-server:route/summary')
const apicache = require('apicache')
const redis = require('redis')
const redisOptions = config.get('redis')

const cacheWithRedis = apicache.options({ redisClient: redis.createClient(redisOptions) }).middleware
const onlyStatus200 = (req, res) => res.statusCode === 200

router.use(httpParams)

/**
 * Run one summary sub-query in-process.
 *
 * Formerly an HTTP POST to this server's own listening port. See
 * PLAN_ELIMINATE_SELF_CALL.md; these four endpoints were among the heaviest self-callers,
 * and `/data/*` self-calls timing out at 120s are what precedes the recorded production
 * abort in api.err.crash-162500.
 *
 * ALL /data/* COUNTS ARE PUBLIC-DATA-ONLY. That is not new — the HTTP version hardcoded
 * `Authorization: ''`, so the inner request was always anonymous — but it is now explicit.
 * `user` is deliberately left undefined and MUST STAY THAT WAY: three of these four
 * endpoints are wrapped in `cacheWithRedis('1 day')`, whose key is `req.originalUrl` with
 * `appendKey: []`. The cache is therefore NOT user-scoped, and a caller identity reaching
 * these queries would publish one user's private counts to every subsequent requester for
 * 24 hours.
 *
 * The old version JSON.parse'd whatever body came back. `util/http.js`'s httpRequest
 * discards res.statusCode, so an inner 4xx/5xx — whose body is a plain-text
 * "A Database Error Occured…" string, not JSON — threw a SyntaxError inside a promise.
 * Where the caller had no rejection handler that became an unhandled rejection, which
 * app.js:34 swallows, leaving the request hung forever and the process's async_hooks state
 * corrupted; the next Solr-backed request then aborted with
 * "Assertion failed: (trigger_async_id) >= (-1)". Reproduced 3/3 locally with a single
 * `GET /data/distinct/genome/host_group?q=foo%3A%28` followed by `GET /data/taxon_category/`.
 * internalQuery removes the whole class: Solrjs returns parsed JSON, and a Solr-reported
 * error becomes a real Error carrying `statusCode`.
 */
async function subQuery (dataType, query, opts) {
  return internalQuery({
    collection: dataType,
    query,
    queryType: 'solr',
    user: undefined,
    requestId: opts && opts.requestId
  })
}

/**
 * Turn an internalQuery rejection into an Express response.
 *
 * Every subQuery consumer needs one of these. A `/data` handler that lets a rejection
 * escape does not merely fail — it never calls next(), so the request hangs holding a
 * worker slot, and under --unhandled-rejections=strict it takes the process with it.
 */
function failSubQuery (res, label) {
  return (err) => {
    const status = err && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    console.error(`[${(new Date()).toISOString()}] /data/${label} failed: ${err && err.message} rid=${res.req && res.req.requestId ? res.req.requestId : '-'}`)
    if (res.headersSent) {
      return
    }
    // 504 is distinguished from the generic database error because it is the one case a
    // caller can act on: the query was too expensive to complete, not malformed and not a
    // server fault. Broad-taxon crossCollection joins hit this — see Docs/TODO.md TODO-1.
    let message = 'Unable to query the database'
    if (status === 400) {
      message = 'Unable to query'
    } else if (status === 504) {
      message = 'The database did not respond in time'
    }
    res.status(status).set('content-type', 'application/json')
      .end(JSON.stringify({ status, message }))
  }
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
        { requestId: req.requestId }
      ).then((results) => {
        res.results = Object.assign(res.results, results.facets)
      })
    )
    defs.push(
      subQuery(
        'genome_feature',
        (console.log(`[CrossCollectionJoin] dataRouter taxon_id=${req.params.taxon_id}`),
        `q=*:*&fq=feature_type:(CDS OR mat_peptide)&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id v=taxon_lineage_ids:${req.params.taxon_id}}&rows=0&facet=true&facet.field=feature_type&facet.mincount=1&json.nl=map`),
        { requestId: req.requestId }
      ).then((results) => {
        const feature_type_count = results.facet_counts.facet_fields.feature_type
        res.results = Object.assign(res.results, feature_type_count)
      })
    )
    defs.push(
      subQuery(
        'protein_structure',
        `q=*:*&fq=taxon_lineage_ids:${req.params.taxon_id}&rows=0`,
        { requestId: req.requestId }
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
        { requestId: req.requestId }
      ).then((results) => {
        const counts = {
          'strains_count': results.response.numFound
        }
        res.results = Object.assign(res.results, counts)
      })
    )

    // .catch() rather than .then(ok, fail): the two-argument form does not catch a throw
    // from inside the success handler, and these handlers do reach into the response shape
    // (results.facets, results.facet_counts.facet_fields.feature_type). An escaping
    // TypeError there is the same unhandled-rejection defect in a different costume.
    Promise.all(defs)
      .then(() => { next() })
      .catch(failSubQuery(res, `summary_by_taxon/${req.params.taxon_id}`))
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
  'genome': ['host_group', 'host_name', 'host_common_name', 'geographic_group', 'isolation_country', 'state_province',
    'segment', 'subtype', 'season', 'lineage', 'clade', 'subclade', 'h1_clade_global', 'h1_clade_us', 'h3_clade', 'h5_clade',
    'isolation_source', 'passage'],
  'genome_feature': ['feature_type', 'gene', 'product'],
  'sp_gene': ['property', 'source', 'evidence'],
  'pathway_ref': ['pathway_name', 'pathway_class'],
  'subsystem_ref': ['subsystem_id', 'subsystem_name'],
  'protein_feature': ['source'],
  'protein_structure': ['method'],
  'surveillance': ['pathogen_type', 'pathogen_test_type', 'pathogen_test_result', 'subtype', 'host_group', 'host_common_name', 'host_species', 'geographic_group', 'collection_country'],
  'serology': ['test_type', 'test_result', 'serotype', 'host_type', 'host_common_name', 'host_species', 'geographic_group', 'collection_country'],
  'sequence_feature': ['evidence_code', 'gene', 'sf_category', 'source', 'source_strain', 'subtype', 'taxon_id']
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
    const query = req.query && req.query.q ? req.query.q : '*:*'

    // `query` is raw user input (?q=). It is not escaped here on purpose: internalQuery runs
    // the same SolrQuerySanitizer gate the HTTP path applied, which is what blocks
    // parameter smuggling (`%26shards%3D…`) through this value. Solr rejects syntactically
    // invalid input on its own, and internalQuery turns that into a 400.
    subQuery(collection, `q=${query}&rows=0&facet=true&facet.field=${field}&facet.mincount=1&facet.limit=-1&json.nl=map`, { requestId: req.requestId })
      .then((body) => {
        const counts = body && body.facet_counts && body.facet_counts.facet_fields
        if (counts && counts[field]) {
          res.results = counts[field]
        } else {
          // A well-formed query that faceted on nothing. Answer with an empty object rather
          // than falling through with no response — the missing else here is what used to
          // leave the request hanging.
          debug(`distinct/${collection}/${field}: no facet counts in response`)
          res.results = {}
        }
        next()
      })
      .catch(failSubQuery(res, `distinct/${collection}/${field}`))
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

    subQuery('subsystem', query, { requestId: req.requestId })
      .then((body) => {
        const pivot = body && body.facet_counts && body.facet_counts.facet_pivot
        const raw_data = pivot && pivot['superclass,class,subclass,subsystem_id']
        if (raw_data) {
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
        } else {
          // Genome with no subsystem rows: Solr omits the pivot entirely. The old code had
          // no else branch here, so this path never responded.
          debug(`subsystem_summary/${genome_id}: no facet_pivot in response`)
          res.results = []
        }
        next()
      })
      .catch(failSubQuery(res, `subsystem_summary/${genome_id}`))
  },
  (req, res, next) => {
    res.set('content-type', 'application/json')
    res.end(JSON.stringify(res.results))
  }
])

module.exports = router
