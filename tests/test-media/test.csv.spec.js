const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const Fs = require('fs')
const Path = require('path')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: Config.get('http_port'),
  agent: agent
}
const ExpectedCsvStream = Fs.readFileSync(Path.join(__dirname, 'expected.csv.stream.txt'), {
  encoding: 'utf8'
})
const ExpectedCsvQuery = Fs.readFileSync(Path.join(__dirname, 'expected.csv.query.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: csv', () => {
  it('Test call_method: stream, single row', async () => {
    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'text/csv',
        'Content-Type': 'application/x-www-form-urlencoded',
        'download': true
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body, ExpectedCsvStream)
      })
  })

  it('Test call_method: stream, multi rows', async () => {
    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'text/csv',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'download': true
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'eq(genome_id,83332.12)&sort(+feature_id)&limit(500)')
      .then((body) => {
        assert.isNotEmpty(body)
      })
  })

  it('Test call_method: query', async () => {
    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'text/csv',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body, ExpectedCsvQuery)
      })
  })
})
