const Config = require('../config')
const { httpGet } = require('./http')
const Http = require('http')
const solrAgentConfig = Config.get('solr').shortLiveAgent
const solrAgent = new Http.Agent(solrAgentConfig)

async function getSequenceByHash (md5) {
  return httpGet({
    port: Config.get('http_port'),
    headers: {
      'Accept': 'application/json'
    },
    agent: solrAgent,
    path: `/feature_sequence/${md5}`
  }).then((body) => {
    const doc = JSON.parse(body)
    return doc.sequence
  })
}

async function getSequenceDictByHash (md5Array) {
  if (md5Array.length === 0) return

  const ids = md5Array.join(',')
  return httpGet({
    port: Config.get('http_port'),
    headers: {
      'Accept': 'application/json'
    },
    agent: solrAgent,
    path: `/feature_sequence/${ids}`
  })
    .then((resp) => {
      if (resp === '') {
        throw Error(`Unable to lookup sequence: ${ids}`)
      }
      if (md5Array.length === 1) {
        const doc = JSON.parse(resp)
        const obj = {}
        obj[doc.md5] = doc.sequence
        return obj
      } else {
        const docs = JSON.parse(resp)
        return docs.reduce((h, cur) => {
          h[cur.md5] = cur.sequence
          return h
        }, {})
      }
    }).catch((err) => {
      console.error(err)
    })
}

module.exports = { getSequenceByHash: getSequenceByHash, getSequenceDictByHash: getSequenceDictByHash }
