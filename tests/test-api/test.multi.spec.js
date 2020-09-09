const assert = require('chai').assert
const Http = require('http')
const { httpRequest } = require('../../util/http')
const Config = require('../../config')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

describe('Test Router - MultiQuery', function () {
  it('POST request', async function () {
    const multiQuery = {
      query1: {
        dataType: 'genome',
        query: 'eq(genome_id,83332.12)'
      },
      query2: {
        dataType: 'genome_feature',
        query: 'and(eq(genome_id,83332.12),eq(annotation,PATRIC),eq(feature_type,CDS),lt(start,5000))'
      }
    }

    return httpRequest({
      port: Config.get('http_port'),
      agent: agent,
      headers: {
        'Content-Type': 'application/json'
      },
      path: '/query/',
      method: 'POST'
    }, JSON.stringify(multiQuery))
      .then((body) => {
        const results = JSON.parse(body)
        // check 1st query result
        const result1 = results['query1'].result
        assert.equal(result1.length, 1)
        assert.equal(result1[0].genome_id, '83332.12')
        assert.equal(result1[0].genome_name, 'Mycobacterium tuberculosis H37Rv')

        // check 2nd query result
        const result2 = results['query2'].result
        assert.equal(result2.length, 4)
      })
  })
})
