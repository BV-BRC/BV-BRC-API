const Config = require('../config')
const { httpGet, httpRequest } = require('./http')

async function getSequenceByHash (md5) {
  return httpGet({
    port: Config.get('http_port'),
    headers: {
      'Accept': 'application/json'
    },
    path: `/feature_sequence/${md5}`
  }, {
    json: true
  }).then((body) => {
    const doc = JSON.parse(body)
    return doc.sequence
  })
}

async function getSequenceDictByHash (md5Array) {
  if (md5Array.length === 0) return

  return httpRequest({
    port: Config.get('http_port'),
    method: 'POST',
    path: `/feature_sequence/`,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/solrquery+x-www-form-urlencoded'
    }
  }, `q=md5:(${md5Array.join(' OR ')})&fl=md5,sequence&rows=${md5Array.length}`)
    .then((resp) => {
      const docs = JSON.parse(resp)
      return docs.reduce((h, cur) => {
        h[cur.md5] = cur.sequence
        return h
      }, {})
    }).catch((err) => {
      console.error(err)
    })
}

module.exports = { getSequenceByHash: getSequenceByHash, getSequenceDictByHash: getSequenceDictByHash }
