const debug = require('debug')('p3api-server:TranscriptomicsGene')
const { httpRequest, httpsGetUrl, httpsRequestUrl } = require('../util/http')
const Config = require('../config')
const WORKSPACE_API_URL = Config.get('workspaceAPI')
const http = require('http')
const Web = require('../web');

const SolrAgent = Web.getSolrShortLiveAgent();

function getWorkspaceObjects (paths, metadataOnly, token) {
  return new Promise((resolve, reject) => {
    if (!(paths instanceof Array)) {
      paths = [paths]
    }
    paths = paths.map(decodeURIComponent)

    httpsRequestUrl(WORKSPACE_API_URL, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': token
      },
      method: 'POST'
    }, JSON.stringify({
      id: 1,
      method: 'Workspace.get',
      version: '1.1',
      params: [{ objects: paths, metadata_only: metadataOnly }]
    })).then((body) => {
      const results = JSON.parse(body)
      if (results.result) {
        const defs = results.result[0].map((obj) => {
          const meta = {
            name: obj[0][0],
            type: obj[0][1],
            path: obj[0][2],
            creation_time: obj[0][3],
            id: obj[0][4],
            owner_id: obj[0][5],
            size: obj[0][6],
            userMeta: obj[0][7],
            autoMeta: obj[0][8],
            user_permissions: obj[0][9],
            global_permission: obj[0][10],
            link_reference: obj[0][11]
          }

          if (metadataOnly) {
            return meta
          }
          if (!meta.link_reference) {
            return ({ metadata: meta, data: obj[1] })
          } else {
            return httpsGetUrl(`${meta.link_reference}?download`, {
              headers: {
                'Authorization': 'OAuth ' + token
              }
            }).then((body) => {
              return {
                'metadata': meta,
                'data': body
              }
            }, (error) => {
              throw error
            })
          }
        })

        Promise.all(defs).then((d) => {
          resolve(d)
        })
      }
    }, (err) => {
      reject(err)
    })
  })
}

function readWorkspaceExperiments (tgState, options) {
  const wsExpIds = tgState['wsExpIds']
  const wsComparisonIds = tgState['wsComparisonIds']
  const expressionFiles = wsExpIds.map(function (exp_id) {
    const parts = exp_id.split('/')
    const jobName = parts.pop()
    return parts.join('/') + '/.' + jobName + '/expression.json'
  })

  return new Promise((resolve, reject) => {
    getWorkspaceObjects(expressionFiles, false, options.token).then((results) => {
      const p3FeatureIdSet = {}
      const p2FeatureIdSet = {}

      const expressions = results.map(function (d) {
        if (!wsComparisonIds) {
          return JSON.parse(d.data)['expression']
        } else {
          return JSON.parse(d.data)['expression'].filter(function (e) {
            return wsComparisonIds.indexOf(e.pid) >= 0
          })
        }
      })

      const flattened = [].concat.apply([], expressions)
      flattened.forEach(function (expression) {
        if (expression.hasOwnProperty('feature_id')) {
          if (!p3FeatureIdSet.hasOwnProperty(expression.feature_id)) {
            p3FeatureIdSet[expression.feature_id] = true
          }
        } else if (expression.hasOwnProperty('na_feature_id')) {
          if (!p2FeatureIdSet.hasOwnProperty(expression.na_feature_id)) {
            p2FeatureIdSet[expression.na_feature_id] = true
          }
        }
      })

      resolve({
        expressions: flattened,
        p3FeatureIds: Object.keys(p3FeatureIdSet),
        p2FeatureIds: Object.keys(p2FeatureIdSet)
      })
    })
  })
}

function readPublicExperiments (tgState, options) {
  return new Promise(async (resolve, reject) => {
    const res = await httpRequest({
      port: Config.get('http_port'),
      headers: {
        'Accept': 'application/solr+json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'Authorization': options.token || ''
      },
      method: 'POST',
      agent: SolrAgent,
      path: '/transcriptomics_gene/'
    }, `${tgState.query}&select(pid,refseq_locus_tag,feature_id,log_ratio,z_score)&limit(1)`)

    let response
    try {
      response = JSON.parse(res)
    } catch (err) {
      reject(new Error(`readPublicExperiments(): Error parsing JSON from SOLR: ${err}`))
    }

    const numFound = response.response.numFound

    const fetchSize = 25000
    const steps = Math.ceil(numFound / fetchSize)
    const allRequests = []

    for (let i = 0; i < steps; i++) {
      const range = 'items=' + (i * fetchSize) + '-' + ((i + 1) * fetchSize - 1)
      const subPromise = httpRequest({
        port: Config.get('http_port'),
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
          'Range': range,
          'Authorization': options.token || ''
        },
        method: 'POST',
        agent: SolrAgent,
        path: '/transcriptomics_gene/'
      }, `${tgState.query}&select(pid,refseq_locus_tag,feature_id,log_ratio,z_score)`)
        .then((body) => JSON.parse(body))
      allRequests.push(subPromise)
    }

    Promise.all(allRequests).then((results) => {
      const expressions = []
      const p3FeatureIdSet = {}

      results.forEach(function (genes) {
        genes.forEach(function (gene) {
          expressions.push(gene)

          if (gene.hasOwnProperty('feature_id')) {
            if (!p3FeatureIdSet.hasOwnProperty(gene.feature_id)) {
              p3FeatureIdSet[gene.feature_id] = true
            }
          }
        })
      })

      resolve({ expressions: expressions, p3FeatureIds: Object.keys(p3FeatureIdSet), p2FeatureIds: [] })
    })
  })
}

function processTranscriptomicsGene (tgState, options) {
  return new Promise((resolve, reject) => {
    let wsCall
    if (tgState.hasOwnProperty('wsExpIds')) {
      wsCall = readWorkspaceExperiments(tgState, options)
    } else {
      wsCall = { expressions: [], p3FeatureIds: [], p2FeatureIds: [] }
    }

    let publicCall
    if (tgState.hasOwnProperty('pbExpIds')) {
      publicCall = readPublicExperiments(tgState, options)
    } else {
      publicCall = { expressions: [], p3FeatureIds: [], p2FeatureIds: [] }
    }

    Promise.all([publicCall, wsCall]).then((results) => {
      const comparisonIdList = tgState.comparisonIds

      const wsP3FeatureIdList = results[1].p3FeatureIds
      const wsP2FeatureIdList = results[1].p2FeatureIds
      const wsExpressions = results[1].expressions

      const pbP3FeatureIdList = results[0].p3FeatureIds
      const pbP2FeatureIdList = results[0].p2FeatureIds // []
      const pbExpressions = results[0].expressions

      const p3FeatureIdList = wsP3FeatureIdList.concat(pbP3FeatureIdList)
      const p2FeatureIdList = wsP2FeatureIdList.concat(pbP2FeatureIdList)
      const expressions = wsExpressions.concat(pbExpressions)

      debug('p3 ids: ', p3FeatureIdList.length, 'p2 ids: ', p2FeatureIdList.length)

      const query_fl = 'feature_id,p2_feature_id,strand,product,accession,start,end,patric_id,refseq_locus_tag,alt_locus_tag,genome_name,genome_id,gene'

      const fetchSize = 10000
      const p3IdSteps = Math.ceil(p3FeatureIdList.length / fetchSize)
      const p2IdSteps = Math.ceil(p2FeatureIdList.length / fetchSize)
      const allRequests = []

      for (let i = 0; i < p3IdSteps; i++) {
        const ids = p3FeatureIdList.slice(i * fetchSize, (i + 1) * fetchSize)
        const partial_q = `q=*:*&fq={!terms f=feature_id method=automaton}${ids.join(',')}&fl=${query_fl}`

        const range = `items=0-${ids.length}`
        const subDef = httpRequest({
          port: Config.get('http_port'),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/solrquery+x-www-form-urlencoded',
            'Range': range,
            'Authorization': options.token || ''
          },
          method: 'POST',
          agent: SolrAgent,
          path: '/genome_feature/'
        }, partial_q).then((body) => JSON.parse(body))
        allRequests.push(subDef)
      }

      for (let i = 0; i < p2IdSteps; i++) {
        const ids = p2FeatureIdList.slice(i * fetchSize, (i + 1) * fetchSize)
        const partial_q = `q=*:*&fq={!terms f=p2_feature_id method=automaton}${ids.join(',')}&fl=${query_fl}`

        const range = `items=0-${ids.length}`
        const subDef = httpRequest({
          port: Config.get('http_port'),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/solrquery+x-www-form-urlencoded',
            'Range': range,
            'Authorization': options.token || ''
          },
          method: 'POST',
          agent: SolrAgent,
          path: '/genome_feature/'
        }, partial_q).then((body) => JSON.parse(body))
        allRequests.push(subDef)
      }

      Promise.all(allRequests).then((body) => {
        const features = [].concat.apply([], body)

        const expressionHash = {}

        expressions.forEach(function (expression) {
          let featureId
          if (expression.hasOwnProperty('feature_id')) {
            featureId = expression.feature_id
          } else if (expression.hasOwnProperty('na_feature_id')) {
            featureId = expression.na_feature_id
          }

          if (!expressionHash.hasOwnProperty(featureId)) {
            var expr = { samples: {} }
            if (expression.hasOwnProperty('feature_id')) { expr.feature_id = expression.feature_id }
            if (expression.hasOwnProperty('na_feature_id')) { expr.p2_feature_id = expression.na_feature_id }
            if (expression.hasOwnProperty('refseq_locus_tag')) { expr.refseq_locus_tag = expression.refseq_locus_tag }
            const log_ratio = expression.log_ratio
            const z_score = expression.z_score
            expr.samples[expression.pid.toString()] = {
              log_ratio: log_ratio || '',
              z_score: z_score || ''
            }
            expr.up = (log_ratio != null && Number(log_ratio) > 0) ? 1 : 0
            expr.down = (log_ratio != null && Number(log_ratio) < 0) ? 1 : 0

            expressionHash[featureId] = expr
          } else {
            expr = expressionHash[featureId]
            if (!expr.samples.hasOwnProperty(expression.pid.toString())) {
              const log_ratio = expression.log_ratio
              const z_score = expression.z_score
              expr.samples[expression.pid.toString()] = {
                log_ratio: log_ratio || '',
                z_score: z_score || ''
              }
              if (log_ratio != null && Number(log_ratio) > 0) { expr.up++ }
              if (log_ratio != null && Number(log_ratio) < 0) { expr.down++ }

              expressionHash[featureId] = expr
            }
          }
        })

        const data = []
        features.forEach(function (feature) {
          let expr
          if (expressionHash.hasOwnProperty(feature.feature_id)) {
            expr = expressionHash[feature.feature_id]
          } else if (expressionHash.hasOwnProperty(feature.p2_feature_id)) {
            expr = expressionHash[feature.p2_feature_id]
          }
          if (expr) {
            // build expr object
            let count = 0
            expr.sample_binary = comparisonIdList.map(function (comparisonId) {
              if (expr.samples.hasOwnProperty(comparisonId) && expr.samples[comparisonId].log_ratio !== '') {
                count++
                return '1'
              } else {
                return '0'
              }
            }).join('')
            expr.sample_size = count

            const datum = Object.assign(feature, expr)
            data.push(datum)
          }
        })

        resolve(data)
      })
    })
  })
}

module.exports = {
  requireAuthentication: false,
  validate: function (params) {
    const tgState = params[0]
    return tgState && tgState.comparisonIds.length > 0
  },
  execute: function (params) {
    return new Promise((resolve, reject) => {
      const tgState = params[0]
      const opts = params[1]

      processTranscriptomicsGene(tgState, opts).then((result) => {
        resolve(result)
      }, (err) => {
        reject(new Error(`Unable to process protein family queries. ${err}`))
      })
    })
  }
}
