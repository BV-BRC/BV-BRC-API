const debug = require('debug')('p3api-server:BiosetResult')
const { httpRequest } = require('../util/http')
const Config = require('../config')
const http = require('http')

const SolrAgentConfig = Config.get('solr').shortLiveAgent
const SolrAgent = new http.Agent(SolrAgentConfig)


function readPublicExperiments (tgState, options) {
  return new Promise(async (resolve, reject) => {
    debug(`readPublicExperiments: ${tgState.query}`)
    const res = await httpRequest({
      port: Config.get('http_port'),
      headers: {
        'Accept': 'application/solr+json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'Authorization': options.token || ''
      },
      method: 'POST',
      agent: SolrAgent,
      path: '/bioset_result/'
    }, `${tgState.query}&limit(1)`)

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
        path: '/bioset_result/'
      }, `${tgState.query}&select(bioset_id,entity_id,entity_name,feature_id,patric_id,locus_tag,gene_id,protein_id,uniprot_id,gene,product,log2_fc,p_value,z_score)`)
        .then((body) => JSON.parse(body))
      allRequests.push(subPromise)
    }

    Promise.all(allRequests).then((results) => {
      const expressions = []
      const p3FeatureIdSet = {}

      results.forEach(function (batch) {
        batch.forEach(function (entity) {
          expressions.push(entity)

          if (entity.hasOwnProperty('entity_id')) {
            if (!p3FeatureIdSet.hasOwnProperty(entity.entity_id)) {
              p3FeatureIdSet[entity.entity_id] = true
            }
          }
        })
      })

      resolve({ expressions: expressions, p3FeatureIds: Object.keys(p3FeatureIdSet) })
    })
  })
}

function processTranscriptomicsGene (tgState, options) {
  return new Promise((resolve, reject) => {
    const allRequests = readPublicExperiments(tgState, options)
    const comparisonIdList = tgState.comparisonIds

    Promise.all([allRequests]).then((body) => {
      const expressions = body[0].expressions
      const features = body[0].p3FeatureIds
      const expressionHash = {}

      expressions.forEach(function (expression) {
        let featureId = expression.entity_id

        if (!expressionHash.hasOwnProperty(featureId)) {
          const expr = Object.assign(expression, { samples: {} })

          const log2_fc = expression.log2_fc
          const z_score = expression.z_score
          const p_value = expression.p_value
          expr.samples[expression.bioset_id] = {
            log2_fc: log2_fc || '',
            z_score: z_score || '',
            p_value: p_value || ''
          }
          expr.up = (log2_fc != null && Number(log2_fc) > 0) ? 1 : 0
          expr.down = (log2_fc != null && Number(log2_fc) < 0) ? 1 : 0
          delete expr.log2_fc
          delete expr.z_score
          delete expr.p_value

          expressionHash[featureId] = expr
        } else {
          const expr = expressionHash[featureId]
          if (!expr.samples.hasOwnProperty(expression.bioset_id)) {
            const log2_fc = expression.log2_fc
            const z_score = expression.z_score
            const p_value = expression.p_value
            expr.samples[expression.bioset_id] = {
              log2_fc: log2_fc || '',
              z_score: z_score || '',
              p_value: p_value || ''
            }
            if (log2_fc != null && Number(log2_fc) > 0) { expr.up++ }
            if (log2_fc != null && Number(log2_fc) < 0) { expr.down++ }

            expressionHash[featureId] = expr
          }
        }
      })

      const data = []
      features.forEach(function (entityId) {
        const expr = expressionHash[entityId]
        if (expr) {
          // build expr object
          let count = 0
          expr.sample_binary = comparisonIdList.map(function (comparisonId) {
            if (expr.samples.hasOwnProperty(comparisonId) && expr.samples[comparisonId].log2_fc !== '') {
              count++
              return '1'
            } else {
              return '0'
            }
          }).join('')
          expr.sample_size = count

          data.push(expr)
        }
      })
      debug(data)
      resolve(data)
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
        reject(new Error(`Unable to process bioset result queries. ${err}`))
      })
    })
  }
}
