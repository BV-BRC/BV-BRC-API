
/**
 * Simple tests to test genome permissions
 *
 * To run:
 *    `node run test-permissions`
 *
 *
 * Configuration:
 *    './config.json' should contain test user
 *      token key/value. (Copy ./config.sample.json)
 *
 */

const assert = require('chai').assert,
  updatePerms = require('../update-genome-perms'),
  rp = require('request-promise');
  token = require('./config.json').token;

const DATA_API_URL = 'http://localhost:3001';
const TEST_GENOMES = ["1763.134"];
const NOT_OWNED_GENOMES = ["83332.349"];

// test over all cores
const CORES = [
	'genome',
  'genome_sequence',
	'genome_feature',
	'pathway',
	'sp_gene',
  'genome_amr'
];

// default options for get requests
const getOpts = {
  resolveWithFullResponse: true,
  json: true,
  headers: {
    "content-type": "application/json",
    "authorization": token || ''
  }
}


describe('Test Genome Permissions', () => {

    // start with single genome
    const genomeID = TEST_GENOMES[0];

    // test params
    const newPerms = [{
        user: "user1@patricbrc.org",
        permission: 'read'
    }, {
        user: "user2@patricbrc.org",
        permission: 'write'
    }]

    const serverUrl =  DATA_API_URL +
      `/genome?eq(genome_id,${genomeID})&select(user_read, user_write)`;

    describe('add new permissions (user1 with read and user2 with write)', () => {

      it('should return 200 with "OK"', function(done) {
        // allow only 10 secs
        this.timeout(10000);


        updatePerms(genomeID, token, newPerms)
          .then(function(res){
            assert.equal(200, res.statusCode);
            assert.equal('OK', res.body);

            done();
          }).catch((err) => { done(err) })
      });

      it('should have correct permissions on genome core', function(done) {
        rp.get(serverUrl, getOpts).then(res => {
          let serverPerms = res.body[0];

          // verify permissions
          verifyPermissions(newPerms, serverPerms);
          done();
        }).catch(e => {
          done(e);
        });
      })

  });



  describe('remove all permissions', () => {
    it('should return 200 with "OK"', function(done) {
      // allow 10 secs
      this.timeout(10000);

      const newPerms = []

      updatePerms(genomeID, token, newPerms)
        .then(function(res){
          assert.equal(200, res.statusCode);
          assert.equal('OK', res.body);

          done();
        }).catch((err) => { done(err) })
    });


    it('should have no permissions on genome core', function(done) {
      rp.get(serverUrl, getOpts).then(res => {
        let serverPerms = res.body[0];
        assert.isObject(serverPerms, 'response is object')
        assert.deepEqual(serverPerms, {}, 'user_read and user_write do not exist')

        done();
      }).catch(e => {
        done(e);
      });
    })

  });



  describe('test bad inputs', function() {
    // allow 10 secs
    this.timeout(10000);

    it('should give 401 without token', function(done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      updatePerms(genomeID, "", newPerms)
        .then(function(res){
          assert.equal(401, res.statusCode);

          done();
        }).catch((err) => { done(err) })
    });


    it('should give 401 if bogus token', function(done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      let realUser = token.split('|')[0].split('=')[1];
      let newToken = token.replace(new RegExp(realUser, 'g'), 'fakeuser');

      updatePerms(genomeID, newToken, newPerms)
        .then(function(res){
          assert.equal(401, res.statusCode);

          done();
        }).catch((err) => { done(err) })
    });


    it('should give 403 if not owner', function(done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        permission: 'read'
      }]

      updatePerms(NOT_OWNED_GENOMES[0], token, newPerms)
        .then(function(res){
          assert.equal(403, res.statusCode);

          done();
        }).catch((err) => { done(err) })
    });


    it('should return 200 for invalid input', function(done) {
      let newPerms = [{
        user: 'asdfasdf',
        permission: 'wwwrite'
      }]

      updatePerms(genomeID, token, newPerms)
        .then(function(res){
          assert.equal(200, res.statusCode);
          assert.equal('OK', res.body);

          done();
        }).catch((err) => { done(err) })
    });

    it('should return 200 for invalid input', function(done) {
      let newPerms = [{
        user: 'user1@patricbrc.org',
        pppppeermission: 'wrrritt'
      }]

      updatePerms(genomeID, token, newPerms)
        .then(function(res){
          assert.equal(200, res.statusCode);
          assert.equal('OK', res.body);

          done();
        }).catch((err) => { done(err) })
    });

    it('should still have no permissions on genome core', function(done) {
      rp.get(serverUrl, getOpts).then(res => {
        let serverPerms = res.body[0];
        assert.isObject(serverPerms, 'response is object')
        assert.deepEqual(serverPerms, {}, 'user_read and user_write do not exist')

        done();
      }).catch(e => {
        done(e);
      });
    })
  });

  it('should return 404 without genome id', function(done) {
    let newPerms = [{
      user: 'user1@patricbrc.org',
      permission: 'write'
    }]

    updatePerms('', token, newPerms)
      .then(function(res){
        assert.equal(404, res.statusCode);

        done();
      }).catch((err) => { done(err) })
  });

}); // end Test Genome Permissions




function verifyPermissions(newPerms, serverPerms) {
  newPerms.forEach(p => {
    if(p.permission == 'read')
      assert.include(serverPerms.user_read, p.user, `${p.user} is in read_perms`)
    if(p.permission == 'write')
      assert.include(serverPerms.user_write, p.user, `${p.user} is in read_perms`)
  })
}
