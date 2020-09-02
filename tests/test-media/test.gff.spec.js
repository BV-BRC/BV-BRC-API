const assert = require('chai').assert
const { httpRequest } = require('../../util/http')
const Http = require('http')
const Config = require('../../config')
const MAX_TIMEOUT = 1 * 60 * 1000

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: Config.get('http_port'),
  agent: agent
}

describe('Test Media Types: gff', function () {
  it('Test call_method: stream', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/gff',
        'Content-Type': 'application/x-www-form-urlencoded',
        'download': true
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body.trimEnd(), ExpectedGffStream.trimEnd())
      })
  })

  it('Test call_method: query', async function () {
    this.timeout(MAX_TIMEOUT)

    return httpRequest(Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/gff',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')
      .then((body) => {
        assert.equal(body, ExpectedGffQuery)
      })
  })
})

const ExpectedGffQuery = '##gff-version 3\n\
#Genome: 83332.12\tMycobacterium tuberculosis H37Rv DNA polymerase III beta subunit (EC 2.7.7.7)\n\
accn|NC_000962\tPATRIC\tCDS\t2052\t3260\t.\t+\t0\tID=fig|83332.12.peg.2;locus_tag=Rv0002;product=DNA polymerase III beta subunit (EC 2.7.7.7);gene=dnaN;Ontology_term=GO:0003887|DNA-directed DNA polymerase activity\n'

// Note. for some reason, there is no line break between genome and feature lines. Could be a bug.
const ExpectedGffStream = '##gff-version 3\n\
#Genome: 83332.12\tMycobacterium tuberculosis H37Rv DNA polymerase III beta subunit (EC 2.7.7.7)\
accn|NC_000962\tPATRIC\tCDS\t2052\t3260\t.\t+\t0\tID=fig|83332.12.peg.2;locus_tag=Rv0002;product=DNA polymerase III beta subunit (EC 2.7.7.7);gene=dnaN;Ontology_term=GO:0003887|DNA-directed DNA polymerase activity\n'
