const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const http = require('http')
const config = require('../../config')
const fs = require('fs')
const Path = require('path')

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

describe('Test Cluster', () => {
  const method = 'cluster'
  const params = JSON.parse(fs.readFileSync(Path.join(__dirname, 'payload.cluster.txt'), {
    encoding: 'utf8'
  }))
  const payload = JSON.stringify({"id": 1, "method": method, "params": params, "jsonrpc": '2.0'})

  it('should return cluster', (done) => {
    (async () => {
      try {
        const res = await httpRequest(requestOptions, payload)
        const body = JSON.parse(res)
        assert.isObject(body)
        assert.containsAllKeys(body, ['result'])
        assert.containsAllKeys(body.result, ['columns', 'rows'])
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})