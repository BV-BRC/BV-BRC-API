const assert = require('chai').assert
const {httpGet} = require('../../util/http')
const http = require('http')
const fs = require('fs')
const Path = require('path')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: 3001,
  agent: agent
}

const ExpectedSralign = fs.readFileSync(Path.join(__dirname, 'expected.sralign.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: sralign+dna+fasta', () => {
  it('Test call_method: query', (done) => {
    (async () => {
      try {
        const body = await httpGet(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/sralign+dna+fasta',
            'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
          },
          path: '/genome_sequence/?eq(genome_id,1310581.3)&limit(25)'
        }))
        assert.equal(body.trimEnd(), ExpectedSralign.trimEnd())
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})

