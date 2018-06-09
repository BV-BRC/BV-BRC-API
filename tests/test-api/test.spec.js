const assert = require('chai').assert
const rp = require('request-promise')
const Url = require('url')

const DATA_API_URL = 'http://localhost:3001'
const maxTimeOut = 3 * 60 * 1000
// const token = require('../config.json').token || ''

const requestOptions = {
  resolveWithFullResponse: true,
  headers: {
    'Content-Type': 'application/json'
  }
}

describe('Test Data Type', () => {

  describe('RQL query on genome', () => {
    const rqlRequestOptions = Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
      }
    })

    const query = 'eq(taxon_lineage_ids,773)&sort(-score)'

    it('GET request', function (done) {
      this.timeout(maxTimeOut)
      const url = Url.resolve(`${DATA_API_URL}/genome/`, `?${query}`)
      console.log(url)
      rp.get(url, rqlRequestOptions)
        .then((res) => {
          assert.equal(200, res.statusCode)
          assert.isString(res.body)
          parsed = JSON.parse(res.body)
          assert.isArray(parsed)
          assert.equal(25, parsed.length)

          done()
        })
        .catch((err) => {
          done(err)
        })
    })

    it('POST request', function (done) {
      this.timeout(maxTimeOut)
      const url = `${DATA_API_URL}/genome/`
      rp.post(url, Object.assign(rqlRequestOptions, {
        body: query
      }))
        .then((res) => {
          assert.equal(200, res.statusCode)
          assert.isString(res.body)
          parsed = JSON.parse(res.body)
          assert.isArray(parsed)
          assert.equal(25, parsed.length)

          done()
        })
        .catch((err) => {
          done(err)
        })
    })
  })

  describe('SolrQuery on genome', function () {
    const solrRequestOptions = Object.assign(requestOptions, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/solrquery+x-www-form-urlencoded'
      }
    })

    const query = 'q=taxon_lineage_ids:773&sort=score+desc'

    it('GET request', function (done) {
      this.timeout(maxTimeOut)
      const url = Url.resolve(`${DATA_API_URL}/genome/`, `?${query}`)
      rp.get(url, solrRequestOptions)
        .then((res) => {
          assert.equal(200, res.statusCode)
          assert.isString(res.body)
          parsed = JSON.parse(res.body)
          assert.isArray(parsed)
          assert.equal(25, parsed.length)

          done()
        })
        .catch((err) => {
          done(err)
        })
    })

    it('POST request', function (done) {
      this.timeout(maxTimeOut)
      const url = `${DATA_API_URL}/genome/`
      rp.post(url, Object.assign(solrRequestOptions, {
        body: query
      }))
        .then((res) => {
          assert.equal(200, res.statusCode)
          assert.isString(res.body)
          parsed = JSON.parse(res.body)
          assert.isArray(parsed)
          assert.equal(25, parsed.length)

          done()
        })
        .catch((err) => {
          done(err)
        })
    })
  })

})
