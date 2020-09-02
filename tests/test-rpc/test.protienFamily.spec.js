const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const http = require('http')
const config = require('../../config')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const requestOptions = {
  port: config.get('http_port'),
  agent: agent,
  method: 'POST',
  headers: {
    'Content-Type': 'application/jsonrpc+json'
  }
}

describe('Test Protein Families', () => {
  const method = 'proteinFamily'
  const params = [{
    'familyType': 'plfam',
    'heatmapAxis': '',
    'genomeIds': ['83332.12'],
    'genomeFilterStatus': {'83332.12': {'index': 0, 'status': 2, 'label': 'Mycobacterium tuberculosis H37Rv'}},
    'clusterRowOrder': [],
    'clusterColumnOrder': [],
    'keyword': '',
    'perfectFamMatch': 'A',
    'min_member_count': null,
    'max_member_count': null,
    'min_genome_count': null,
    'max_genome_count': null
  }, {}]
  const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})

  it('should return 200 with "OK" and result', (done) => {
    (async () => {
      try {
        const res = await httpRequest(requestOptions, payload)
        const body = JSON.parse(res)
        assert.isObject(body)
        assert.containsAllKeys(body, ['result'])
        assert.isAtLeast(body.result.length, 1)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})