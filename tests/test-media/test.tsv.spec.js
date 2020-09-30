const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const Fs = require('fs')
const Path = require('path')

const MAX_TIMEOUT = 1 * 60 * 1000

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: Config.get('http_port'),
  agent: agent
}
const ExpectedTsvStream = Fs.readFileSync(Path.join(__dirname, 'expected.tsv.stream.txt'), {
  encoding: 'utf8'
})
const ExpectedTsvQuery = Fs.readFileSync(Path.join(__dirname, 'expected.tsv.query.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: tsv', function () {
  it('Test call_method: stream', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'text/tsv',
        'Content-Type': 'application/x-www-form-urlencoded',
        'download': true
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body, ExpectedTsvStream)
      })
  })

  it('Test call_method: query', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'text/tsv',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body, ExpectedTsvQuery)
      })
  })
})
