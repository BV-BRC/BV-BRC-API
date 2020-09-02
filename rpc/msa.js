const debug = require('debug')('p3api-server:msa')
const ChildProcess = require('child_process')
const Config = require('../config')
const http = require('http')
const Temp = require('temp')
const fs = require('fs-extra')
const { httpRequest } = require('../util/http')
const { getSequenceDictByHash } = require('../util/featureSequence')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

async function runQuery (query, opts) {

  const features = await httpRequest({
    port: Config.get('http_port'),
    agent: agent,
    method: 'POST',
    headers: {
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': opts.token || ''
    },
    path: `/genome_feature/`
  }, query)
    .then(
      (body) => JSON.parse(body),
      (err) => {
       console.error(err)
      })

  const md5Array = features.map((f) => {
    return (opts.alignType === 'dna') ? f.na_sequence_md5 : f.aa_sequence_md5
  }).filter((md5) => md5)

  const md5Hash = await getSequenceDictByHash(md5Array)

  return features.map((f) => {
    if (opts.alignType === 'dna') {
      f.na_sequence = md5Hash[f.na_sequence_md5]
    } else {
      f.aa_sequence = md5Hash[f.aa_sequence_md5]
    }
    return f
  })
}

function buildFasta (sequences, opts) {
  return new Promise((resolve, reject) => {
    const fasta = []
    // build faa with stripped name so gblocks doesn't complain.
    sequences.forEach((o) => {
      let fasta_id
      if (o.feature_type === 'source') { return }
      if (o.annotation === 'PATRIC') {
        fasta_id = o.feature_id
      } else if (o.annotation === 'RefSeq') {
        fasta_id = o.feature_id
      }
      let row = '>' + fasta_id + ' [' + o.genome_id + ']\n' + o.aa_sequence + '\n'
      if (opts.alignType === 'dna') {
        row = '>' + fasta_id + ' [' + o.genome_id + ']\n' + o.na_sequence + '\n'
      }
      fasta.push(row)
    })

    resolve(fasta.join(''))
  })
}

function runMuscle (sequences, opts) {
  return new Promise((resolve, reject) => {
    const output = []
    let errorClosed = false

    // debug('Run Aligner')
    const child = ChildProcess.spawn('muscle', ['-fasta', '-maxhours', '0.03'], {
      stdio: [
        'pipe',
        'pipe', // pipe child's stdout to parent
        'pipe'
      ]
    })

    child.stdout.on('data', (data) => {
      output.push(data.toString())
    })

    child.stderr.on('data', (errData) => {
      // debug(`Muscle STDERR Data: ${errData.toString()}`)
    })

    child.on('error', (err) => {
      errorClosed = true
      reject(err)
    })

    child.on('close', (code) => {
      debug('Muscle Process closed.', code)
      if (!errorClosed) {
        resolve(output.join(''))
      }
    })

    child.stdin.write(sequences, 'utf8')
    child.stdin.end()
  })
}

function runGBlocks (input, opts) {
  return new Promise((resolve, reject) => {
    let errorClosed = false
    const tempName = Temp.path({suffix: '.aga'})

    fs.outputFile(tempName, input, (err) => {
      if (err) { reject(err); return }

      // debug('Run Gblocks')
      const child = ChildProcess.spawn('Gblocks', [tempName, '-b5=h'], {
        stdio: [
          'pipe',
          'pipe', // pipe child's stdout to parent
          'pipe'
        ]
      })

      child.stderr.on('data', (errData) => {
        // debug('GBlocks STDERR Data: ', errData.toString())
      })

      child.on('error', (err) => {
        errorClosed = true
        reject(err)
      })

      child.on('close', (code) => {
        debug('GBlocks Process closed.', code)
        if (!errorClosed) {
          fs.exists(tempName + '-gb', (exists) => {
            if (!exists) {
              reject('Gblocks Output Does Not Exist')
              return
            }

            fs.readFile(tempName + '-gb', 'utf8', (err, data) => {
              if (err) {
                reject(`Unable to Read Gblocks output: ${err}`)
                return
              }

              const lines = data.split('\n')
              const isEmpty = (!lines.some((line) => {
                line = line.trim()
                if (!line || line.length === 0) { return false };
                if (line === '>undefined') { return false };

                if (line.charAt(0) === '>') { return false }

                return true
              }))

              if (!isEmpty) {
                resolve(data)
              } else {
                fs.readFile(tempName, 'utf8', (err, rawData) => {
                  resolve(rawData)
                })
              }
            })
          })
        }
      })
    })
  })
}

function runFastTree (input, opts) {
  return new Promise((resolve, reject) => {
    const output = []
    let errorClosed = false
    const tempName = Temp.path({suffix: '.aga-gb'})

    fs.outputFile(tempName, input, (err) => {
      const runOpts = ['-gamma', '-nosupport']
      if (opts.alignType === 'dna') {
        runOpts.push('-nt')
      }
      runOpts.push(tempName)
      const child = ChildProcess.spawn('FastTree_LG', runOpts, {
        stdio: [
          'pipe',
          'pipe', // pipe child's stdout to parent
          'pipe'
        ]
      })

      child.stdout.on('data', (data) => {
        // debug('FastTree_LG Output Data: ', data.toString())
        output.push(data.toString())
      })

      child.stderr.on('data', (errData) => {
        // debug('FastTree_LG STDERR Data: ', errData.toString())
      })

      child.on('error', (err) => {
        errorClosed = true
        reject(err)
      })

      child.on('close', (code) => {
        debug('FastTree_LG Process closed.', code)
        if (!errorClosed) {
          resolve(output.join(''))
        }
      })
    })

  })
}

module.exports = {
  requireAuthentication: false,
  validate: function (params, req, res) {
    // validate parameters here
    return params && params[0] && params[0].length > 1
  },
  execute: async function (params, req, res) {
    return new Promise(async (resolve, reject) => {
      const query = params[0]
      let alignType = 'protein'
      if (params.length > 1) {
        alignType = params[1]
      }
      const opts = {req: req, user: req.user, token: req.headers.authorization, alignType: alignType}

      const sequences = await runQuery(query, opts).catch((err) => {
        reject(`Unable To Retreive Feature Data for MSA: ${err}`)
      })
      buildFasta(sequences, opts).then((fasta) => {
        runMuscle(fasta, opts).then((alignment) => {
          runGBlocks(alignment, opts).then((gblocksOut) => {
            runFastTree(gblocksOut, opts).then((fastTree) => {
              const map = {}
              sequences.forEach((seq) => {
                map[seq.feature_id] = {
                  'genome_name': seq.genome_name,
                  'feature_id': seq.feature_id,
                  'genome_id': seq.genome_id,
                  'patric_id': seq.patric_id,
                  'aa_length': seq.aa_length,
                  'refseq_locus_tag': seq.refseq_locus_tag
                }
              })

              resolve({
                map: map,
                alignment: alignment,
                tree: fastTree
              })
            }, (errFastTree) => {
              reject(`Unable to Complete FastTree: ${errFastTree}`)
            })
          }, (errGBlocks) => {
            reject(`Unable to Complete GBLocks for Alignment: ${errGBlocks}`)
          })
        }, (errMuscle) => {
          reject(`Unable to Complete Alignement: ${errMuscle}`)
        })
      }, (errBuildFasta) => {
        reject(`Unable to build Fasta: ${errBuildFasta}`)
      })
    })
  }
}
