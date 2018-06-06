/**
 * genomePermissionRouter
 *
 * Creates endpoint for editing genome permissions (and all associated cores)
 *
 * Example POST:  /permissions/genome/xxxxx.xx,xxxxx.xx
 *   [{
 *    user: "user1@patricbrc.org",
 *    permission: 'read'
 *  }, {
 *    user: "user2@patricbrc.org",
 *    permission: 'write'
 *  }, {
 *    user: "user3@patricbrc.org",
 *    permission: 'unchanged'     // leave permissions as is for given genomes
 *  }]
 *
 */
const express = require('express')
const router = express.Router({strict: true, mergeParams: true})

const PublicDataTypes = require('../middleware/PublicDataTypes')
const authMiddleware = require('../middleware/auth')
const httpParams = require('../middleware/http-params')
const bodyParser = require('body-parser')

const debug = require('debug')('p3api-server:genomePermissions')
const conf = require('../config')

const Solrjs = require('solrjs')
const SOLR_URL = conf.get('solr').url
const request = require('request-promise')

const genomeCoresUUIDs = {
  genome: 'genome_id',
  genome_sequence: 'sequence_id',
  genome_feature: 'feature_id',
  pathway: 'id',
  sp_gene: 'id',
  genome_amr: 'id',
  subsystem: 'id'
}

router.use(httpParams)
router.use(authMiddleware)
router.use(PublicDataTypes)

router.post('/:target_id', [
  bodyParser.json({type: ['application/json'], limit: '100mb'}),
  updatePermissions
])

function updatePermissions (req, res, next) {
  if (!req._body || !req.body) {
    console.log('no body')
    return next()
  }

  const collection = 'genome'
  const permissions = req.body
  const genomeIDs = req.params.target_id.split(',')

  // ensure parameters are correct, or respond with appropriate message
  const hasPassed = testParams(req, res)
  if (!hasPassed) return

  // keep track of total number of docs updated
  let numDocsUpdated = 0

  let proms = []
  genomeIDs.forEach(genomeID => {
    debug(`genomeID: ${genomeID}`)

    // update objects from all genome-related cores
    Object.keys(genomeCoresUUIDs).forEach(core => {
      debug(`updating core ${core}...`)

      const solr = new Solrjs(SOLR_URL + '/' + core)

      // for each core, fetch object keys, owners, user_read, user_write
      // Notes:
      //  -  keys are needed to update objects
      //  -  owner, user_read, user_write are needed to check permissions
      //         and for "unchanged" option.
      let key = genomeCoresUUIDs[core]
      let query = `q=genome_id:${genomeID}&fl=${key},owner,user_read,user_write&rows=100000`
      var prom = solr.query(query)
        .then(r => {
          debug(`retrieved records for genome ${genomeID} (core: ${core})...`)

          // get only actual records
          var records = r.response.docs

          // skip empty records
          if (records.length === 0) {
            debug(`skipping empty records for core/genome: ${core}/${genomeID}`)
            return
          }

          numDocsUpdated += records.length

          // create a command for each record
          let commands = []
          records.forEach(record => {
            if (!(record.owner === req.user)) {
              console.error(
                `User ${req.user} was forbidden from private data ${genomeID} ` +
                `[core: ${core}; record: ${record[key]}]`
              )
              res.sendStatus(403)
            }

            commands.push(
              toSetCommand(record, record[key], permissions, core)
            )
          })

          return updateSOLR(commands, core)
        }, err => {
          console.error(`Error retrieving ${collection} with id: ${genomeID}`)
          res.status(406).send('Error retrieving target')
          res.end()
        })

      proms.push(prom)
    })
  })

  Promise.all(proms)
    .then(r => {
      debug(`success.  Number of Docs Updated: ${numDocsUpdated}`)
      res.sendStatus(200)
    }).catch(err => {
      debug('FAILED', err)
      res.status(406).send('Error updating document' + err)
    })
}

function testParams (req, res) {
  if (!req.user) {
    res.status(401).send('User not logged in, permission denied.')
    return
  } else if (!req.params.target_id) {
    res.status(400).send(
      'Request must must contain genome id(s). I.e., /permissions/genome/9999.9999'
    )
    return
  }

  return true
}

function toSetCommand (record, id, permissions, core) {
  let readUsers = permissions
    .filter(p => p.permission === 'read')
    .map(p => {
      if (p.permission === 'read') return p.user
    })

  // Note: we must also ensure write users can read.
  // 'read' and 'write' are not exclusive so that
  //  Data API queries are faster
  let writeUsers = permissions
    .filter(p => p.permission === 'write')
    .map(p => {
      if (p.permission === 'write') {
        readUsers.push(p.user)
        return p.user
      }
    })

  // keep any existing permissions requested unchanged
  let unChangedUsers = permissions
    .filter(p => p.permission === 'unchanged')
    .map(p => {
      if (p.permission === 'unchanged') return p.user
    })

  if (unChangedUsers.length) {
    unChangedUsers.forEach(user => {
      if (record.user_read && record.user_read.includes(user)) { readUsers.unshift(user) }
      if (record.user_write && record.user_write.includes(user)) { writeUsers.unshift(user) }
    })
  }

  // remove possibility of duplicates
  readUsers = readUsers.filter((x, i) => readUsers.indexOf(x) === i)
  writeUsers = writeUsers.filter((x, i) => writeUsers.indexOf(x) === i)

  let cmd = {}
  cmd[genomeCoresUUIDs[core]] = id

  cmd.user_read = {set: readUsers}
  cmd.user_write = {set: writeUsers}

  return cmd
}

function updateSOLR (commands, core) {
  let url = SOLR_URL + `/${core}/update?wt=json&softCommit=true`

  return request(url, {
    json: true,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: commands
  }).then(r => {
    debug(`${core} update successful`)
  }).catch(e => {
    console.error(e.error)
  })
}

module.exports = router
