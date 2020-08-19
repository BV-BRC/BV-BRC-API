const assert = require('chai').assert
const {httpGet} = require('../../util/http')
const http = require('http')
const fs = require('fs')
const config = require('../../config')
const treeDir = config.get('treeDirectory')
const Path = require('path')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 3
})
const requestOptions = {
  port: 3001,
  agent: agent
}

describe('Test Media Types: newick', () => {
  it('Test media type: newick', (done) => {
    (async () => {
      try {
        const body = await httpGet(Object.assign(requestOptions, {
          headers: {
            'Accept': 'application/newick',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          path: '/taxonomy/1763'
        }))

        const path = Path.join(treeDir, '2037.newick')
        const expected = fs.readFileSync(path, {
          encoding: 'utf8'
        })
        assert.equal(body.trimEnd(), expected.trimEnd())
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})
