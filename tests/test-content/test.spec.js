const assert = require('chai').assert
const http = require('http')
const { httpGet } = require('../../util/http')
const Config = require('../../config')
const Path = require('path')
const Fs = require('fs')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const ExpectedHostSummary = Fs.readFileSync(Path.join(__dirname, '../../content/host/patric_host_summary.json'), {
  encoding: 'utf8'
})

describe('Test Router - Content', function () {

  it('Host', async function () {
    return httpGet({
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      path: '/content/host/patric_host_summary.json'
    })
    .then((body) => {
      assert.equal(body, ExpectedHostSummary)
    })
  })
})