const assert = require('chai').assert
const http = require('http')

const DATA_API_PORT = 3001
const maxTimeOut = 3 * 60 * 1000

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

async function responseHander(res) {
  let body = ''
  res.on('data', (chunk) => {
    // console.log(chunk)
    body += chunk
  })

  res.on('end', () => {
    return JSON.parse(body)
  })
}

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
      this.timeout(maxTimeOut)

      http.get(Object.assign(rqlRequestOptions, {
        path: `/genome/?${query}`
      }), (res) => {
        assert.equal(200, res.statusCode)

        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          assert.isString(body)
          parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        })
      })
      .on('error', (err) => {
        done(err)
      })
    })

    it('POST request', function (done) {
      this.timeout(maxTimeOut)

      const req = http.request(Object.assign(rqlRequestOptions, {
        path: '/genome/',
        method: 'POST'
      }), (res) => {
        assert.equal(200, res.statusCode)

        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          assert.isString(body)
          parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        })
      })
      .on('error', (err) => {
          done(err)
      })
      req.write(query)
      req.end()
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
      this.timeout(maxTimeOut)

      http.get(Object.assign(solrRequestOptions, {
        path: `/genome/?${query}`
      }), (res) => {
        assert.equal(200, res.statusCode)

        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          assert.isString(body)
          parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        })
      })
      .on('error', (err) => {
        done(err)
      })
    })

    it('POST request', function (done) {
      this.timeout(maxTimeOut)
      const req = http.request(Object.assign(solrRequestOptions, {
        path: '/genome/',
        method: 'POST'
      }), (res) => {
        assert.equal(200, res.statusCode)

        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })

        res.on('end', () => {
          assert.isString(body)
          parsed = JSON.parse(body)
          assert.isArray(parsed)
          assert.isAtLeast(25, parsed.length)
          done()
        })
      })
      .on('error', (err) => {
        done(err)
      })
      req.write(query)
      req.end()
    })
  })
})
