const assert = require('chai').assert
const {httpRequest} = require('../../util/http')
const http = require('http')
const config = require('../../config')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: config.get('http_port'),
  agent: agent
}

describe('Test Media Types: gff', () => {
  it('Test call_method: stream', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/gff',
            'Content-Type': 'application/x-www-form-urlencoded',
            'download': true
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        assert.equal(body, ExpectedGffStream)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
  it('Test call_method: query', (done) => {
    (async () => {
      try {
        const body = await httpRequest(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/gff',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          method: 'POST',
          path: '/genome_feature/'
        }), 'rql=eq%28feature_id%252CPATRIC.83332.12.NC_000962.CDS.2052.3260.fwd%29%2526sort%28%252Bfeature_id%29%2526limit%281%29')

        assert.equal(body, ExpectedGffQuery)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})

const ExpectedGffQuery = "##gff-version 3\n\
#Genome: 83332.12\tMycobacterium tuberculosis H37Rv DNA polymerase III beta subunit (EC 2.7.7.7)\n\
accn|NC_000962\tPATRIC\tCDS\t2052\t3260\t.\t+\t0\tID=fig|83332.12.peg.2;locus_tag=Rv0002;product=DNA polymerase III beta subunit (EC 2.7.7.7);gene=dnaN;Ontology_term=GO:0003887|DNA-directed DNA polymerase activity\n"

// Note. for some reason, there is no line break between genome and feature lines. Could be a bug.
const ExpectedGffStream = "##gff-version 3\n\
#Genome: 83332.12\tMycobacterium tuberculosis H37Rv DNA polymerase III beta subunit (EC 2.7.7.7)\
accn|NC_000962\tPATRIC\tCDS\t2052\t3260\t.\t+\t0\tID=fig|83332.12.peg.2;locus_tag=Rv0002;product=DNA polymerase III beta subunit (EC 2.7.7.7);gene=dnaN;Ontology_term=GO:0003887|DNA-directed DNA polymerase activity\n"