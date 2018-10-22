const Request = require('request-promise')
// Request.debug = true
const config = require('../config')
const distributeURL = config.get('distributeURL')

async function getSequenceByHash (md5) {
  return Request.get(`${distributeURL}feature_sequence/${md5}`, {
    json: true
  }).then((doc) => doc.sequence)
}

async function getSequenceDictByHash (md5Array) {
  if (md5Array.length === 0) return

  return Request({
    method: 'POST',
    uri: `${distributeURL}feature_sequence/`,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/solrquery+x-www-form-urlencoded'
    },
    body: `q=md5:(${md5Array.join(' OR ')})&fl=md5,sequence&rows=${md5Array.length}`
  }).then((resp) => {
    const docs = JSON.parse(resp)
    return docs.reduce((h, cur) => {
      h[cur.md5] = cur.sequence
      return h
    }, {})
  }).catch((err) => {
    console.error(err)
  })
}

module.exports = {getSequenceByHash: getSequenceByHash, getSequenceDictByHash: getSequenceDictByHash}
