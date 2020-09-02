const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const Fs = require('fs')
const Path = require('path')

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

describe('Test Cluster', function () {
  const method = 'cluster'
  const params = JSON.parse(Fs.readFileSync(Path.join(__dirname, 'payload.cluster.txt'), {
    encoding: 'utf8'
  }))
  const payload = JSON.stringify({ 'id': 1, 'method': method, 'params': params, 'jsonrpc': '2.0' })

  it('should return cluster', async function () {
    // avoid using arrow function to customize timeout
    this.timeout(5 * 60 * 1000) // 5 Mins

    // async evaluation requires promise
    return httpRequest(requestOptions, payload).then((res) => {
      const body = JSON.parse(res)
      assert.isObject(body)
      assert.containsAllKeys(body, ['result'])
      assert.containsAllKeys(body.result, ['columns', 'rows'])
    })
  })
})
