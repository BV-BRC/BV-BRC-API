const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Path = require('path')
const Fs = require('fs')
const Config = require('../../config')
const MAX_TIMEOUT = 1 * 60 * 1000

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const requestOptions = {
  port: Config.get('http_port'),
  agent: agent,
  method: 'POST',
  headers: {
    'Content-Type': 'application/jsonrpc+json'
  }
}

describe('Test Protein Families', function () {
  const method = 'proteinFamily'
  const params = [{
    'familyType': 'plfam',
    'heatmapAxis': '',
    'genomeIds': ['83332.12'],
    'genomeFilterStatus': { '83332.12': { 'index': 0, 'status': 2, 'label': 'Mycobacterium tuberculosis H37Rv' } },
    'clusterRowOrder': [],
    'clusterColumnOrder': [],
    'keyword': '',
    'perfectFamMatch': 'A',
    'min_member_count': null,
    'max_member_count': null,
    'min_genome_count': null,
    'max_genome_count': null
  }, {}]
  const payload = JSON.stringify({ 'id': 1, 'method': method, 'params': params, 'jsonrpc': '2.0' })
  const ExpectedProteinFamily = Fs.readFileSync(Path.join(__dirname, 'expected.proteinFamily.json'), {
    encoding: 'utf8'
  })
  const ExpectedProteinFamilyJson = JSON.parse(ExpectedProteinFamily)['result']

  it('PLFam for 83332.12', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(requestOptions, payload)
      .then((res) => {
        const body = JSON.parse(res)
        // console.log(body)
        assert.isObject(body)
        assert.containsAllKeys(body, ['result'])
        assert.isAtLeast(body.result.length, 1)
        assert.deepEqual(body['result'], ExpectedProteinFamilyJson)
      })
  })
})
