
/**
 * Simple tests to test genome permission updates
 *
 * To run:
 *    `node run test-permissions`
 *
 *
 * Configuration:
 *  './config.json' should contain test user  token key/value.
 *     (Copy ./config.sample.json)
 *
 */

const assert = require('chai').assert
const updatePerms = require('./update-genome-perms')
const rp = require('request-promise')
const token = require('../config.json').token

const DATA_API_URL = 'http://localhost:3001'

// for small tests
// these ids are taken from:
//   50-test-genome-ids.json
//   50-test-genome-ids-2.json
const TEST_GENOMES = ['66877.3']
const NOT_OWNED_GENOMES = ['105579.5']

// for large tests
const TEST_SIZE = 10
const TIMEOUT = 5 * (60 * 1000) // 5 mins

// test over all cores
const CORES = [
  'genome',
  'genome_sequence',
  'genome_feature',
  'pathway',
  'sp_gene',
  'genome_amr',
  'subsystem'
]

// default options for get requests
const getOpts = {
  resolveWithFullResponse: true,
  json: true,
  headers: {
    'content-type': 'application/json',
    'authorization': token || ''
  }
}

describe('Test Genome Permissions', () => {
  // start with single genome
  const genomeID = TEST_GENOMES[0]

  // test params
  const newPerms = [{
    user: 'user1@patricbrc.org',
    permission: 'read'
  }, {
    user: 'user2@patricbrc.org',
    permission: 'write'
  }]

  const serverUrl = DATA_API_URL +
      `/genome?eq(genome_id,${genomeID})&select(user_read, user_write)`

  describe('add new permissions (user1 with read and user2 with write)', function () {
    it('should return 200 with "OK"', function (done) {
      // allow only 10 secs
      this.timeout(10000)

      updatePerms(genomeID, token, newPerms)
        .then(res => {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)
          done()
        }).catch(e => {
          done(e)
        })
    })

    it('should have correct permissions on genome core', function (done) {
      rp.get(serverUrl, getOpts).then(res => {
        let serverPerms = res.body[0]

        // verify permissions
        verifyPermissions(newPerms, serverPerms)
        done()
      }).catch(e => {
        done(e)
      })
    })
  })

  describe('remove all permissions', () => {
    it('should return 200 with "OK"', function (done) {
      // allow 10 secs
      this.timeout(10000)

      // set with no permissions
      const newPerms = []

      updatePerms(genomeID, token, newPerms)
        .then(function (res) {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)

          done()
        }).catch(e => {
          done(e)
         })
    })

    it('should have no permissions on genome core', function (done) {
      rp.get(serverUrl, getOpts).then(res => {
        let serverPerms = res.body[0]
        assert.isObject(serverPerms, 'response is object')
        assert.deepEqual(serverPerms, {}, 'user_read and user_write do not exist')

        done()
      }).catch(e => {
        done(e)
      })
    })
  })




  describe('test bad inputs', function () {
    // allow 10 secs
    this.timeout(10000)

    it('should give 401 without token', function (done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      updatePerms(genomeID, '', newPerms)
        .then(res => {
          done(true) // fail test otherwise
        }).catch(e => {
          assert.equal(401, e.statusCode)
          done()
        })
    })

    it('should give 401 if bogus token', function (done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      let realUser = token.split('|')[0].split('=')[1]
      let newToken = token.replace(new RegExp(realUser, 'g'), 'fakeuser')

      updatePerms(genomeID, newToken, newPerms)
        .then(res => {
          done(true)
        }).catch(e => {
          assert.equal(401, e.statusCode)
          done()
        })
    })

    it('should give 403 if not owner', function (done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      updatePerms(NOT_OWNED_GENOMES[0], token, newPerms)
        .then(res => {
          done(true)
        }).catch(e => {
          assert.equal(403, e.statusCode)
          done()
        })
    })

    // server ignores anything that is not "user" or "permission"
    // and filters for only "read"/"write"/"unchanged" permissions
    it('should return 200 for invalid input', function (done) {
      let newPerms = [{
        user: 'asdfasdf',
        permission: 'wwwrite'
      }]

      updatePerms(genomeID, token, newPerms)
        .then(res => {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)
          done()
        }).catch(e => {
          done(e)
        })
    })

    it('should return 200 for invalid input', function (done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        pppppeermission: 'wrrritt'
      }]

      updatePerms(genomeID, token, newPerms)
        .then(function (res) {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)
          done()
        }).catch(e => {
          done(e)
        })
    })

    it('should still have no permissions on genome core', function (done) {
      rp.get(serverUrl, getOpts).then(res => {
        let serverPerms = res.body[0]
        assert.isObject(serverPerms, 'response is object')
        assert.deepEqual(serverPerms, {}, 'user_read and user_write do not exist')
        done()
      }).catch(e => {
        done(e)
      })
    })

    it('should return 404 without genome id', function (done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'write'
      }]

      updatePerms('', token, newPerms)
        .then(res => {
          done(true)
        }).catch(e => {
          assert.equal(404, e.statusCode)
          done()
        })
    })

  }) // end bad inputs
}) // end Test Genome Permissions


describe('Test Bulk Permissions', () => {
  // test params
  const newPerms = [{
    user: 'user1@patricbrc.org',
    permission: 'read'
  }, {
    user: 'user2@patricbrc.org',
    permission: 'write'
  }]

  // genome ids to be fetched (to test against)
  let genomeIDs

  describe(`add permissions to ${TEST_SIZE} genomes`, () => {
    it(`can fetch ${TEST_SIZE} genome ids`, function (done) {
      // only 10 secs
      this.timeout(5000)

      getGenomeIDs(TEST_SIZE).then(ids => {
        genomeIDs = ids
        done()
      }).catch(e => { done(e) })
    })

    it(`can update permissions on ${TEST_SIZE} genomes`, function (done) {
      this.timeout(TIMEOUT)

      updatePerms(genomeIDs, token, newPerms)
        .then(function (res) {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)

          done()
        }).catch(e => { done(e) })
    })

    it(`reports correct permissions`, function (done) {
      this.timeout(TIMEOUT)

      let proms = []
      genomeIDs.forEach(id => {
        CORES.forEach(core => {
          // genome_amr and subsystem cores may be empty for some given genomes
          if (['genome_amr', 'subsystem'].indexOf(core) !== -1) return;

          const serverUrl = DATA_API_URL +
          `/${core}?eq(genome_id,${id})&select(user_read,user_write)`

          let prom = rp.get(serverUrl, getOpts).then(res => {
            let serverPerms = res.body[0]
            verifyPermissions(newPerms, serverPerms)
          })

          proms.push(prom)
        })
      })

      Promise.all(proms).then(res => {
        done()
      }).catch(e => done(e))
    })
  })

  const permSize = 200
  let permOpts = ['read', 'write']
  let bigPerms = []

  for (let i = 0; i <= permSize; i++) {
    bigPerms.push({
      user: 'user' + i + '@patricbrc.org',
      permission: permOpts[Math.round(Math.random())]
    })
  }

  describe(`add ${permSize} permissions to ${TEST_SIZE} genomes`, () => {
    it(`can fetch ${TEST_SIZE} genome ids`, function (done) {
      // allow 5 secs
      this.timeout(5000)

      getGenomeIDs(TEST_SIZE).then(ids => {
        genomeIDs = ids
        done()
      }).catch(e => {
        done(e)
      })
    })

    it(`can update permissions ${TEST_SIZE} genomes with ${permSize} permissions`, function (done) {
      this.timeout(TIMEOUT)

      updatePerms(genomeIDs, token, bigPerms)
        .then(function (res) {
          assert.equal(200, res.statusCode)
          assert.equal('OK', res.body)

          done()
        }).catch((e) => {
          done(e)
        })
    })

    it(`reports correct permissions`, function (done) {
      this.timeout(TIMEOUT)

      let proms = []
      genomeIDs.forEach(id => {
        CORES.forEach(core => {
          // genome_amr and subsystem cores may be empty for some given genomes
          if (['genome_amr', 'subsystem'].indexOf(core) !== -1) return;

          const serverUrl = DATA_API_URL +
          `/${core}?eq(genome_id,${id})&select(user_read, user_write)`

          let prom = rp.get(serverUrl, getOpts).then(res => {
            let serverPerms = res.body[0]
            verifyPermissions(bigPerms, serverPerms)
          })

          proms.push(prom)
        })
      })

      Promise.all(proms).then(res => {
        done()
      }).catch(e => done(e))
    })
  })

}) // end Bulk Permissions




/**
 * returns promise with list of private genome IDs based on number requested
 * @param {*} numIDs
 */
function getGenomeIDs (numIDs) {
  const query = `?limit(${numIDs})&eq(public,false)&select(genome_id)&keyword(*)`
  const url = `${DATA_API_URL}/genome/${query}`
  return rp.get(url, getOpts).then(res => {
    return res.body.map(o => o.genome_id)
  })
}

function verifyPermissions (newPerms, serverPerms, core, id) {
  newPerms.forEach(p => {
    if (p.permission === 'read') { assert.include(serverPerms.user_read, p.user, `${p.user} is in read_perms`) }
    if (p.permission === 'write') { assert.include(serverPerms.user_write, p.user, `${p.user} is in read_perms`) }
  })
}
