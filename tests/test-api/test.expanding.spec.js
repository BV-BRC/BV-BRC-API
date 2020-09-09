const assert = require('chai').assert
const Http = require('http')
const { httpRequest } = require('../../util/http')
const Config = require('../../config')
const Token = require('../config.json').token

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Middleware - RQLQueryParser', function () {
  it('with workspaceObject', async function () {
    return httpRequest({
      port: Config.get('http_port'),
      headers: {
        Authorization: Token,
        Accept: 'application/solr+json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome/'
    }, 'in(genome_id,GenomeGroup(%2Fharry%40patricbrc.org%2Fhome%2FGenome%20Groups%2FEscherichia%20representative%20genomes))&select(genome_id)'
    ).then((body) => {
      const data = JSON.parse(body)
      // console.log(data)
      assert.equal(data.response.numFound, 4)
    }, (err) => {
      console.error(err)
    })
  })

  it('secondDegreeInteraction', async function () {
    return httpRequest({
      port: Config.get('http_port'),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/ppi/'
    }, 'secondDegreeInteraction(PATRIC.83332.12.NC_000962.CDS.34.1524.fwd)&eq(evidence,experimental)'
    ).then((body) => {
      const data = JSON.parse(body)
      // console.log(data)
      assert.equal(data.length, 1)
    })
  })

  it('join query', async function () {
    return httpRequest({
      port: Config.get('http_port'),
      headers: {
        Accept: 'application/solr+json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      },
      method: 'POST',
      path: '/genome_feature/'
    }, 'join(genome,eq(genome_id,83332.12),genome_id)&and(eq(annotation,PATRIC),eq(feature_type,CDS))&select(feature_id)&limit(1)'
    ).then((body) => {
      const data = JSON.parse(body)
      // console.log(data)
      assert.isAtLeast(data.response.numFound, 1000)
    })
  })
})
