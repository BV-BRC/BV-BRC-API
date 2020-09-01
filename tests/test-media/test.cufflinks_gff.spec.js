const assert = require('chai').assert
const {httpGet, httpRequest} = require('../../util/http')
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
const ExpectedCufflinksGff2 = fs.readFileSync(Path.join(__dirname, 'expected.cufflinks_gff.2.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: cufflinks+gff', () => {
  it('Test call_method: query/GET', (done) => {
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

  // Expects "Parent line"
  it('Test call_method: query/POST', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/cufflinks+gff',
            'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'and(eq(genome_id,83332.12),eq(annotation,PATRIC),eq(feature_type,CDS))&sort(+accession,+start,+end)&limit(25)')
        assert.equal(body.trimEnd(), ExpectedCufflinksGff2.trimEnd())
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})

