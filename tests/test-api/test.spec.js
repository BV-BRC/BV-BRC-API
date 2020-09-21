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

    const query = 'q=taxon_lineage_ids:773&sort=score+desc'

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
})
