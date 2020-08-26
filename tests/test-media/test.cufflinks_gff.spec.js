const assert = require('chai').assert
const {httpGet} = require('../../util/http')
const http = require('http')
const config = require('../../config')
const fs = require('fs')
const Path = require('path')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: config.get('http_port'),
  agent: agent
}

const ExpectedCufflinksGff = fs.readFileSync(Path.join(__dirname, 'expected.cufflinks_gff.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: cufflinks+gff', () => {
  it('Test call_method: query', (done) => {
    (async () => {
      try {
        const body = await httpGet(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/cufflinks+gff',
            'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
          },
          path: '/genome_feature/?and(eq(genome_id,1310581.3),eq(annotation,PATRIC),eq(feature_type,rRNA))&sort(+accession,+start,+end)&limit(25000)'
        }))
        assert.equal(body.trimEnd(), ExpectedCufflinksGff.trimEnd())
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})

