const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const token = require('../config.json').token || ''
const MAX_TIMEOUT = 2 * 60 * 1000
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

describe('Test Transcriptomics Gene page', function () {
  const method = 'transcriptomicsGene'

  describe('public experiment', function () {
    const params = [{
      'heatmapAxis': '',
      'comparisonIds': ['100000211', '100000212', '100000213', '100000214'],
      'comparisonFilterStatus': {
        '100000211': { 'index': 0, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 24 hrs vs 0 hrs' },
        '100000212': { 'index': 1, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 4 hrs vs 0 hrs' },
        '100000213': { 'index': 2, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 48 hrs vs 0 hrs' },
        '100000214': { 'index': 3, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 8 hrs vs 0 hrs' }
      },
      'clusterRowOrder': [],
      'clusterColumnOrder': [],
      'significantGenes': 'Y',
      'colorScheme': 'rgb',
      'maxIntensity': 0,
      'keyword': '',
      'filterGenome': null,
      'upFold': 0,
      'downFold': 0,
      'upZscore': 0,
      'downZscore': 0,
      'query': 'in(eid,(2000001,2000001,2000001,2000001))',
      'pbExpIds': ['2000001'],
      'pbComparisons': [
        { 'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 24 hrs vs 0 hrs', 'pid': '100000211', 'expmean': 0.0030526617 },
        { 'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 4 hrs vs 0 hrs', 'pid': '100000212', 'expmean': 0.013806473 },
        { 'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 48 hrs vs 0 hrs', 'pid': '100000213', 'expmean': -0.0064450633 },
        { 'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 8 hrs vs 0 hrs', 'pid': '100000214', 'expmean': 0.008426608 }
      ]
    }, { token: token }]

    it('shold return result', async function () {
      this.timeout(MAX_TIMEOUT)

      const payload = JSON.stringify({ 'id': 1, 'method': method, 'params': params, 'jsonrpc': '2.0' })
      return httpRequest(requestOptions, payload)
        .then((res) => {
          const body = JSON.parse(res)
          assert.isObject(body)
          assert.containsAllKeys(body, ['result'])
          assert.isAtLeast(body.result.length, 1)
        })
    })
  })

  describe('workspace object', function () {
    const params = [{
      'heatmapAxis': '',
      'comparisonIds': ['80a036ce-6aa8-11e8-901b-002590829e0aS0', '80a036ce-6aa8-11e8-901b-002590829e0aS1', '80a036ce-6aa8-11e8-901b-002590829e0aS2'],
      'comparisonFilterStatus': {
        '80a036ce-6aa8-11e8-901b-002590829e0aS0': { 'index': 0, 'status': 2, 'label': 'COL vs MERO' },
        '80a036ce-6aa8-11e8-901b-002590829e0aS1': { 'index': 1, 'status': 2, 'label': 'COL vs MHB' },
        '80a036ce-6aa8-11e8-901b-002590829e0aS2': { 'index': 2, 'status': 2, 'label': 'MERO vs MHB' }
      },
      'clusterRowOrder': [],
      'clusterColumnOrder': [],
      'significantGenes': 'Y',
      'colorScheme': 'rgb',
      'maxIntensity': 0,
      'keyword': '',
      'filterGenome': null,
      'upFold': 0,
      'downFold': 0,
      'upZscore': 0,
      'downZscore': 0,
      'wsExpIds': ['/PATRIC@patricbrc.org/PATRIC%20Workshop/RNA-Seq/.Acinetobacter_AMR_treatments/Acinetobacter_AMR_treatments_diffexp'],
      'wsComaprisons': [
        { 'expmean': -0.2620460631, 'genes': 2149, 'pid': '80a036ce-6aa8-11e8-901b-002590829e0aS0', 'sig_z_score': 12, 'sampleUserGivenId': 'COL vs MERO', 'expname': 'COL vs MERO', 'sig_log_ratio': 1010, 'expstddev': 19.351378158 },
        { 'expmean': -0.7354886345, 'genes': 2204, 'pid': '80a036ce-6aa8-11e8-901b-002590829e0aS1', 'sig_z_score': 21, 'sampleUserGivenId': 'COL vs MHB', 'expname': 'COL vs MHB', 'sig_log_ratio': 1299, 'expstddev': 17.9376742144 },
        { 'expmean': -0.4388945358, 'genes': 2066, 'pid': '80a036ce-6aa8-11e8-901b-002590829e0aS2', 'sig_z_score': 12, 'sampleUserGivenId': 'MERO vs MHB', 'expname': 'MERO vs MHB', 'sig_log_ratio': 740, 'expstddev': 10.6871591703 }
      ]
    }, { token: token }]

    it('shold return result', async function () {
      this.timeout(MAX_TIMEOUT)

      const payload = JSON.stringify({ 'id': 1, 'method': method, 'params': params, 'jsonrpc': '2.0' })
      return httpRequest(requestOptions, payload)
        .then((res) => {
          const body = JSON.parse(res)
          assert.containsAllKeys(body, ['result'])
          assert.isAtLeast(body.result.length, 1)
        })
    })
  })
})
