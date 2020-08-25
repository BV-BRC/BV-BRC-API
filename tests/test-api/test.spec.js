const assert = require('chai').assert
const http = require('http')
const {httpGet, httpRequest} = require('../../util/http')

const DATA_API_PORT = 3001
// const maxTimeOut = 3 * 60 * 1000

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Router - Data Type', () => {
  describe('RQL query on genome', () => {
    const rqlRequestOptions = {
      port: DATA_API_PORT,
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
      port: DATA_API_PORT,
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
})
