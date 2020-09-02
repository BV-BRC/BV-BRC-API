const assert = require('chai').assert
const { httpGet } = require('../../util/http')
const Http = require('http')
const Fs = require('fs')
const Path = require('path')
const Config = require('../../config')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: Config.get('http_port'),
  agent: agent
}

const ExpectedSralign = Fs.readFileSync(Path.join(__dirname, 'expected.sralign.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: sralign+dna+fasta', function () {
  it('Test call_method: query', async function () {
    return httpGet(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/sralign+dna+fasta',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      path: '/genome_sequence/?eq(genome_id,1310581.3)&limit(25)'
    }))
      .then((body) => {
        assert.equal(body.trimEnd(), ExpectedSralign.trimEnd())
      })
  })
})
