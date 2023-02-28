const Config = require('../config')
const { httpGet } = require('./http')
const Http = require('http')
const solrAgentConfig = Config.get('solr').shortLiveAgent
const solrAgent = new Http.Agent(solrAgentConfig)
const distributeURL = Config.get('distributeURL')
const axios = require("axios")

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

async function _getSequenceDictByHash (md5Array) { 
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

async function getSequenceDictByHash (md5Array,req) { 
  // console.log("getSequenDictByHash")
  const ids = md5Array.join(',')
  const q = `&in(md5,(${ids}))&limit(9999)&select(md5,sequence)` 

  // console.log("query: ", q)
  if (distributeURL.charAt(distributeURL.length-1)=="/"){
    var url = `${distributeURL}feature_sequence/`
  }else{
    var url = `${distributeURL}/feature_sequence/`
  }
  return axios.post(url, q, {
      headers: {
        'accept': 'application/json',
        'authorization': (req && req.headers['authorization']) ? req.headers['authorization'] : ''
      }
    }).then((response)=>{
      var docs = response.data
      // console.log("Docs: ", docs.length)
      return docs.reduce((h, cur) => {
        h[cur.md5] = cur.sequence
        return h
      }, {})
    })
  }

module.exports = { getSequenceByHash: getSequenceByHash, getSequenceDictByHash: getSequenceDictByHash }
