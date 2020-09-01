const assert = require('chai').assert
const http = require('http')
const {httpGet, httpRequest} = require('../../util/http')
const config = require('../../config')
const Path = require('path')
const Fs = require('fs')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Router - Data Type', () => {
  describe('RQL query on genome', () => {
    const rqlRequestOptions = {
      port: config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      }
    }

    const query = 'eq(taxon_lineage_ids,773)&sort(-score)'

    it('GET request', function (done) {
      (async () => {
        try {
          const body = await httpGet(Object.assign(rqlRequestOptions, {
            path: `/genome/?${query}`
          }))
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        } catch (error) {
          done(error)
        }
      })()
    })

    it('POST request', function (done) {
      // this.timeout(maxTimeOut)

      (async () => {
        try {
          const body = await httpRequest(Object.assign(rqlRequestOptions, {
            path: '/genome/',
            method: 'POST'
          }), query)
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        } catch (error) {
          done(error)
        }
      })()
    })
  })

  describe('SolrQuery on genome', function () {
    const solrRequestOptions = {
      port: config.get('http_port'),
      agent: agent,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    }

    const query = 'q=taxon_lineage_ids:773&sort=score+desc'

    it('GET request', function (done) {
      (async () => {
        try {
          const body = await httpGet(Object.assign(solrRequestOptions, {
            path: `/genome/?${query}`
          }))
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        } catch (error) {
          done(error)
        }
      })()
    })

    it('POST request', function (done) {
      (async () => {
        try {
          const body = await httpRequest(Object.assign(solrRequestOptions, {
            path: '/genome/',
            method: 'POST'
          }), query)
          const parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        } catch (error) {
          done(error)
        }
      })()
    })
  })

  describe('Get Schema', () => {
    const requestOptions = {
      port: config.get('http_port'),
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

    it('GET genome schema', (done) => {
      (async () => {
        try {
          const body = await httpGet(requestOptions)
          const parsed = JSON.parse(body)
          assert.deepEqual(parsed.schema, ExpectedSchemaJson)
          done()
        } catch (error) {
          done(error)
        }
      })()
    })
  })
})
