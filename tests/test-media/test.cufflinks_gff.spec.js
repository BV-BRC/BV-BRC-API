const assert = require('chai').assert
const { httpGet, httpRequest } = require('../../util/http')
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

const ExpectedCufflinksGff = Fs.readFileSync(Path.join(__dirname, 'expected.cufflinks_gff.txt'), {
  encoding: 'utf8'
})
const ExpectedCufflinksGff2 = Fs.readFileSync(Path.join(__dirname, 'expected.cufflinks_gff.2.txt'), {
  encoding: 'utf8'
})

describe('Test Media Types: cufflinks+gff', function () {
  it('Test call_method: query/GET', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpGet(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/cufflinks+gff',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      path: '/genome_feature/?and(eq(genome_id,1310581.3),eq(annotation,PATRIC),eq(feature_type,rRNA))&sort(+accession,+start,+end)&limit(25000)'
    }))
      .then((body) => {
        assert.equal(body.trimEnd(), ExpectedCufflinksGff.trimEnd())
      })
  })

  // Expects "Parent line"
  it('Test call_method: query/POST', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/cufflinks+gff',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'and(eq(genome_id,83332.12),eq(annotation,PATRIC),eq(feature_type,CDS))&sort(+accession,+start,+end)&limit(25)')
      .then((body) => {
        assert.equal(body.trimEnd(), ExpectedCufflinksGff2.trimEnd())
      })
  })
})
