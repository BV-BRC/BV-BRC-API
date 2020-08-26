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

describe('Test Multiple Sequence Alignment', () => {
  const method = 'multipleSequenceAlignment'
  
  it('should return Nucleotide MSA', (done) => {
    (async () => {
      const params = ['in(feature_id,(PATRIC.572418.5.NC_015758.CDS.3452.4438.fwd,PATRIC.572418.5.NC_015758.CDS.2053.3261.fwd,PATRIC.572418.5.NC_015758.CDS.34.1524.fwd))&limit(500)', 'dna']
      const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})
      try {
        const res = await httpRequest(requestOptions, payload)
        const body = JSON.parse(res)
        assert.isObject(body)
        assert.containsAllKeys(body, ['result'])
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  it('should return Amino Acide MSA', (done) => {
    (async () => {
      const params = ['in(feature_id,(PATRIC.572418.5.NC_015758.CDS.3452.4438.fwd,PATRIC.572418.5.NC_015758.CDS.2053.3261.fwd,PATRIC.572418.5.NC_015758.CDS.34.1524.fwd))&limit(500)', 'protein']
      const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})
      try {
        const res = await httpRequest(requestOptions, payload)
        const body = JSON.parse(res)
        assert.isObject(body)
        assert.containsAllKeys(body, ['result'])
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})
