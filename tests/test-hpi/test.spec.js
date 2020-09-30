const assert = require('chai').assert
const Http = require('http')
const { httpGet, httpRequest } = require('../../util/http')
const Config = require('../../config')
const MAX_TIMEOUT = 60 * 1000
const Fs = require('fs')
const Path = require('path')
const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const requestOption = {
  port: Config.get('http_port'),
  agent: agent,
  headers: {
    Accept: 'application/json'
  }
}

describe('Test Router - HPI Search', function () {
  it('GET /hpi/search/experiment', async function () {
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.experiment.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/experiment'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('GET /hpi/search/experiment/GSE79731', async function () {
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.experiment.GSE79731.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/experiment/GSE79731'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('GET /hpi/search/experiment/GSE79731/id-list/100000211', async function () {
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.experiment.GSE79731.id_list.0.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/experiment/GSE79731/id-list/100000211'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('GET /hpi/search/experiment/GSE79731/id-list/100000211/ids', async function () {
    this.timeout(MAX_TIMEOUT)
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.experiment.GSE79731.id_list.1.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/experiment/GSE79731/id-list/100000211/ids'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('GET /hpi/search/experiment/GSE79731/id-list/100000211/ids?includeOrthologs=human', async function () {
    this.timeout(MAX_TIMEOUT)
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.experiment.GSE79731.id_list.2.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/experiment/GSE79731/id-list/100000211/ids?includeOrthologs=human'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('GET /hpi/search/api', async function () {
    this.timeout(MAX_TIMEOUT)
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.api.json'))
    return httpGet(Object.assign(requestOption, {
      path: '/hpi/search/api'
    })).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })

  it('POST /hpi/search', async function () {
    const Expected = Fs.readFileSync(Path.join(__dirname, 'expected.post.json'))
    return httpRequest(Object.assign(requestOption, {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      path: '/hpi/search'
    }), '{ "type": "gene", "idSource": "alt_locus_tag", "ids": ["NP_031402.3", "XP_011246971.1"], "threshold": 0.5, "thresholdType": "percent_matched", "organism": "Mus musculus", "additionalFlags": { "useOrthology": "false" } }'
    ).then((res) => {
      assert.deepEqual(JSON.parse(res), JSON.parse(Expected))
    })
  })
})
