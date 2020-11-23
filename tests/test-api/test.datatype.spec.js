const assert = require('chai').assert
const Http = require('http')
const { httpGet, httpRequest } = require('../../util/http')
const Config = require('../../config')
const Path = require('path')
const Fs = require('fs')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Router - Data Type', () => {
  describe('RQL query on genome', () => {
    const rqlRequestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      }
    }

    const query = 'eq(taxon_lineage_ids,773)&sort(-score)'

    it('GET request', async function () {
      return httpGet(Object.assign(rqlRequestOptions, {
        path: `/genome/?${query}`
      }))
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
        })
    })

    it('POST request', async function () {
      return httpRequest(Object.assign(rqlRequestOptions, {
        path: '/genome/',
        method: 'POST'
      }), query)
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
        })
    })
  })

  describe('SolrQuery on genome', function () {
    const solrRequestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }

    const query = 'q=taxon_lineage_ids:773+AND+reference_genome:*&sort=score+desc'

    it('GET request', async function () {
      return httpGet(Object.assign(solrRequestOptions, {
        path: `/genome/?${query}`
      }))
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
        })
    })

    it('POST request', async function () {
      return httpRequest(Object.assign(solrRequestOptions, {
        path: '/genome/',
        method: 'POST'
      }), query)
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
        })
    })
  })

  describe('Application examples', function () {
    const solrRequestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }
    const rqlRequestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      }
    }

    it('GET boosted query', async function () {
      return httpGet(Object.assign(solrRequestOptions, {
        path: `/taxonomy/?q=((taxon_name:*Brucella*)%20OR%20(taxon_name:Brucella))%20AND%20(taxon_rank:superkingdom^7000000%20OR%20taxon_rank:phylum^6000000%20OR%20taxon_rank:class^5000000%20OR%20taxon_rank:order^4000000%20OR%20taxon_rank:family^3000000%20OR%20taxon_rank:genus^2000000%20OR%20taxon_rank:species^1000000%20OR%20taxon_rank:*)&fl=taxon_name,taxon_id,taxon_rank,lineage_names&qf=taxon_name`
      }))
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
        })
    })

    it('POST many ORs', async function () {
      const payload = Fs.readFileSync(Path.join(__dirname, 'payload.app.txt'), {
        encoding: 'utf8'
      })
      return httpRequest(Object.assign(rqlRequestOptions, {
        method: 'POST',
        path: '/genome/'
      }), payload)
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(parsed.length, 25)
        })
        .catch((err) => {
          console.error(err)
        })
    })
  })

  describe('Get Schema', () => {
    const requestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json'
      },
      path: '/genome/schema'
    }
    const ExpectedSchema = Fs.readFileSync(Path.join(__dirname, 'expected.schema.genome.json'), {
      encoding: 'utf8'
    })
    const ExpectedSchemaJson = JSON.parse(ExpectedSchema)

    it('GET genome schema', async function () {
      return httpGet(requestOptions)
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.deepEqual(parsed.schema, ExpectedSchemaJson)
        })
    })
  })

  describe('Test Solr get handler', () => {
    const requestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json'
      },
      path: '/genome/83332.12'
    }

    it('GET genome schema', async function () {
      return httpGet(requestOptions)
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.deepEqual(parsed.genome_id, '83332.12')
        })
    })
  })

  describe('Test Error handler', () => {
    const requestOptions = {
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      }
    }

    it('Expect 404 - in(genome_id:())', async function () {
      return httpGet(Object.assign(requestOptions, {
        path: '/genome/?in(genome_id:())'
      }))
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.equal(parsed.status, 400)
          assert.equal(parsed.message, 'Query Syntax Error: in(genome_id:())')
        })
    })
    it('Expect 404 - in(taxon_id:())', async function () {
      return httpGet(Object.assign(requestOptions, {
        path: '/genome/?in(taxon_id:())'
      }))
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.equal(parsed.status, 400)
          assert.equal(parsed.message, 'Query Syntax Error: in(taxon_id:())')
        })
    })

    it('Expect 404 - SolrQuery Syntax Error', async function () {
      return httpGet({
        port: Config.get('http_port'),
        agent: agent,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/solrquery+x-www-form-urlencoded'
        },
        path: '/genome/?q=taxon_id:&fl=lineage_ids,lineage_names,lineage_ranks&rows=25000'
      })
        .then((body) => {
          const parsed = JSON.parse(body)
          assert.equal(parsed.status, 400)
          assert.equal(parsed.message, 'Error in parsing query: q=taxon_id:')
        })
    })
  })
})
