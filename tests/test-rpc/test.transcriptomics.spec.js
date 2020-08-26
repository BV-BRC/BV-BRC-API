const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const http = require('http')
const config = require('../../config')
const token = require('../config.json').token || ''

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


describe('Test Transcriptomics Gene page', () => {
  const method = 'transcriptomicsGene'

  describe('public experiment', () => {
    const params = [{
      'heatmapAxis': '',
      'comparisonIds': ['100000211', '100000212', '100000213', '100000214'],
      'comparisonFilterStatus': {
        '100000211': {'index': 0, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 24 hrs vs 0 hrs'},
        '100000212': {'index': 1, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 4 hrs vs 0 hrs'},
        '100000213': {'index': 2, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 48 hrs vs 0 hrs'},
        '100000214': {'index': 3, 'status': 2, 'label': 'MTB infected mouse bone-marrow derived macrophages, 8 hrs vs 0 hrs'}
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
        {'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 24 hrs vs 0 hrs', 'pid': '100000211', 'expmean': 0.0030526617},
        {'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 4 hrs vs 0 hrs', 'pid': '100000212', 'expmean': 0.013806473},
        {'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 48 hrs vs 0 hrs', 'pid': '100000213', 'expmean': -0.0064450633},
        {'eid': 2000001, 'expname': 'MTB infected mouse bone-marrow derived macrophages, 8 hrs vs 0 hrs', 'pid': '100000214', 'expmean': 0.008426608}
      ]
    }, {token: token}]

    it('shold return result', (done) => {
      (async () => {
        const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})
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

//   describe('workspace object', () => {
//     const params = [{
//       'heatmapAxis': '',
//       'comparisonIds': ['4bf364a6-6a52-11e8-8803-002590829e0aS0', '4bf364a6-6a52-11e8-8803-002590829e0aS1', '4bf364a6-6a52-11e8-8803-002590829e0aS2'],
//       'comparisonFilterStatus': {
//         '4bf364a6-6a52-11e8-8803-002590829e0aS0': {'index': 0, 'status': 2, 'label': 'COL vs MHB'},
//         '4bf364a6-6a52-11e8-8803-002590829e0aS1': {'index': 1, 'status': 2, 'label': 'MERO vs COL'},
//         '4bf364a6-6a52-11e8-8803-002590829e0aS2': {'index': 2, 'status': 2, 'label': 'MERO vs MHB'}
//       },
//       'clusterRowOrder': [],
//       'clusterColumnOrder': [],
//       'significantGenes': 'Y',
//       'colorScheme': 'rgb',
//       'maxIntensity': 0,
//       'keyword': '',
//       'filterGenome': null,
//       'upFold': 0,
//       'downFold': 0,
//       'upZscore': 0,
//       'downZscore': 0,
//       'wsExpIds': ['/PATRIC@patricbrc.org/PATRIC%20Workshop/ASM%20Microbe%202018/RNA-Seq/.Abaumannii_AMR_treatments/Abaumannii_AMR_treatments_diffexp'],
//       'wsComaprisons': [
//         {'expmean': -0.66225549, 'genes': 2203, 'pid': '4bf364a6-6a52-11e8-8803-002590829e0aS0', 'sig_z_score': 17, 'sampleUserGivenId': 'COL vs MHB', 'expname': 'COL vs MHB', 'sig_log_ratio': 1297, 'expstddev': 17.843524264},
//         {'expmean': 0.2688476162, 'genes': 2149, 'pid': '4bf364a6-6a52-11e8-8803-002590829e0aS1', 'sig_z_score': 12, 'sampleUserGivenId': 'MERO vs COL', 'expname': 'MERO vs COL', 'sig_log_ratio': 1007, 'expstddev': 19.3514995681},
//         {'expmean': -0.3483243464, 'genes': 2065, 'pid': '4bf364a6-6a52-11e8-8803-002590829e0aS2', 'sig_z_score': 8, 'sampleUserGivenId': 'MERO vs MHB', 'expname': 'MERO vs MHB', 'sig_log_ratio': 736, 'expstddev': 10.5018995298}
//       ]
//     }, {token: token}]

//     it('shold return result', function (done) {
//       this.timeout(maxTimeOut)

//       buildRemoteProcedureCallRequest(method, params)
//         .then(function (res) {
//           assert.equal(200, res.statusCode)
//           assert.isObject(res.body)
//           assert.containsAllKeys(res.body, ['result'])
//           assert.isAtLeast(res.body.result.length, 1)

//           done()
//         }).catch((err) => {
//           done(err)
//         })
//     })
//   })
})


async function buildRemoteProcedureCallRequest (method, params) {
  const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})
  return httpRequest(requestOptions, payload)
}
