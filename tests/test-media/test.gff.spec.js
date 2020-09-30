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

const ExpectedGffStream = Fs.readFileSync(Path.join(__dirname, 'expected.gff.stream.txt'), {
  encoding: 'utf8'
})

const ExpectedGffQuery = Fs.readFileSync(Path.join(__dirname, 'expected.gff.query.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: gff', function () {
  it('Test call_method: stream', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/gff',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'download': true
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'in(feature_id,(PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd))&sort(+feature_id)&limit(1)')
      .then((body) => {
        assert.equal(body, ExpectedGffStream)
      })
  })

  it('Test call_method: query', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/gff',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'in(feature_id,(PATRIC.83332.12.NC_000962.CDS.2052.3260.fwd))&sort(+feature_id)&limit(1)')
      .then((body) => {
        assert.equal(body, ExpectedGffQuery)
      })
  })
})
