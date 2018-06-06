var Defer = require('promised-io/promise').defer
var when = require('promised-io/promise').when
var debug = require('debug')('p3api-server:msa')
var ChildProcess = require('child_process')
var config = require('../config')
var request = require('request')
var distributeURL = config.get('distributeURL')
var Temp = require('temp')
var fs = require('fs-extra')

function runQuery (query, opts) {
  debug('Query: ', query)
  var def = new Defer()

  debug('Send Request to distributeURL: ', distributeURL + 'genome_feature')
  debug('runQuery: ', query)
  request.post({
    url: distributeURL + 'genome_feature/',
    headers: {
      'content-type': 'application/rqlquery+x-www-form-urlencoded',
      'accept': 'application/json',
      'Authorization': opts.token || ''
    },
    body: query
  }, function (err, r, body) {
    // debug("Distribute RESULTS: ", body);

    if (err) {
      return def.reject(err)
    }

    if (body && typeof body === 'string') {
      body = JSON.parse(body)
    }
    def.resolve(body)
  })

  return def.promise
}

function buildFasta (sequences, opts) {
  var fasta = []
  // build faa with stripped name so gblocks doesn't complain.
  sequences.forEach(function (o) {
    var fasta_id
    if (o.feature_type === 'source') { return }
    if (o.annotation === 'PATRIC') {
      fasta_id = o.feature_id
    } else if (o.annotation === 'RefSeq') {
      fasta_id = o.feature_id
    }
    var row = '>' + fasta_id + ' [' + o.genome_id + ']\n' + o.aa_sequence + '\n'
    if (opts.alignType === 'dna') {
      row = '>' + fasta_id + ' [' + o.genome_id + ']\n' + o.na_sequence + '\n'
    }
    fasta.push(row)
  })

  return fasta.join('')
}

function runMuscle (sequences, opts) {
  var def = new Defer()
  var d = []
  var errorClosed

  debug('Run Aligner')
  var child = ChildProcess.spawn('muscle', ['-fasta', '-maxhours', '0.03'], {
    stdio: [
      'pipe',
      'pipe', // pipe child's stdout to parent
      'pipe'
    ]
  })

  child.stdout.on('data', function (data) {
    debug('Muscle Output Data: ', data.toString())
    d.push(data.toString())
  })

  child.stderr.on('data', function (errData) {
    debug('Muscle STDERR Data: ', errData.toString())
  })

  child.on('error', function (err) {
    errorClosed = true
    def.reject(err)
  })

  child.on('close', function (code) {
    debug('Muscle Process closed.', code)
    if (!errorClosed) {
      def.resolve(d.join(''))
    }
  })

  child.stdin.write(sequences, 'utf8')
  child.stdin.end()

  return def.promise
}

function runGBlocks (input, opts) {
  var def = new Defer()
  var errorClosed
  var tempName = Temp.path({suffix: '.aga'})

  // console.log("GBlocks Temp File Input: ", tempName)

  fs.outputFile(tempName, input, function (err) {
    if (err) { def.reject(err); return }

    debug('Run Gblocks')
    var child = ChildProcess.spawn('Gblocks', [tempName, '-b5=h'], {
      stdio: [
        'pipe',
        'pipe', // pipe child's stdout to parent
        'pipe'
      ]
    })

    child.stderr.on('data', function (errData) {
      debug('GBlocks STDERR Data: ', errData.toString())
    })

    child.on('error', function (err) {
      errorClosed = true
      def.reject(err)
    })

    child.on('close', function (code) {
      debug('GBlocks Process closed.', code)
      if (!errorClosed) {
        // console.log("Read File: ", tempName + "-gb");
        fs.exists(tempName + '-gb', function (exists) {
          if (!exists) {
            def.reject('Gblocks Output Does Not Exist')
            return
          }

          fs.readFile(tempName + '-gb', 'utf8', function (err, data) {
            if (err) {
              def.reject('Unable to Read Gblocks output: ', err)
              return
            }

            var lines = data.split('\n')
            var empty = (!lines.some(function (line) {
              line = line.trim()
              if (!line || line.length === 0) { return false };
              if (line === '>undefined') { return false };

              if (line.charAt(0) === '>') { return false }

              return true
            }))

            if (!empty) {
              def.resolve(data)
            } else {
              fs.readFile(tempName, 'utf8', function (err, rawData) {
                def.resolve(rawData)
              })
            }
            // console.log("locusList: ", locusList);
            // def.resolve(locusList.join("\n"));
          })
        })
      }
      // fs.unlink(tempName);
    })
  })

  return def.promise
}

function runFastTree (input, opts) {
  var def = new Defer()
  var d = []
  var errorClosed

  debug('Run FastTre_LG')

  var tempName = Temp.path({suffix: '.aga-gb'})

  // console.log("GBlocks Temp File Input: ", tempName)

  fs.outputFile(tempName, input, function (err) {
    var runOpts = ['-gamma', '-nosupport']
    if (opts.alignType === 'dna') {
      runOpts.push('-nt')
    }
    runOpts.push(tempName)
    var child = ChildProcess.spawn('FastTree_LG', runOpts, {
      stdio: [
        'pipe',
        'pipe', // pipe child's stdout to parent
        'pipe'
      ]
    })

    child.stdout.on('data', function (data) {
      debug('FastTree_LG Output Data: ', data.toString())
      d.push(data.toString())
    })

    child.stderr.on('data', function (errData) {
      debug('FastTree_LG STDERR Data: ', errData.toString())
    })

    child.on('error', function (err) {
      errorClosed = true
      def.reject(err)
    })

    child.on('close', function (code) {
      debug('FastTree_LG Process closed.', code)
      if (!errorClosed) {
        def.resolve(d.join(''))
      }
    })
  })

  return def.promise
}

module.exports = {
  requireAuthentication: false,
  validate: function (params, req, res) {
    // validate parameters here
    return params && params[0] && params[0].length > 1
  },
  execute: function (params, req, res) {
    var def = new Defer()
    // console.log("Execute MSA: ", params)
    var query = params[0]
    var alignType = 'protein'
    if (params.length > 1) {
      alignType = params[1]
    }
    var opts = {req: req, user: req.user, token: req.headers.authorization, alignType: alignType}

    when(runQuery(query, opts), function (sequences) {
      when(buildFasta(sequences, opts), function (fasta) {
        when(runMuscle(fasta, opts), function (alignment) {
          when(runGBlocks(alignment, opts), function (gblocksOut) {
            when(runFastTree(gblocksOut, opts), function (fastTree) {
              var map = {}
              sequences.forEach(function (seq) {
                map[seq.feature_id] = {
                  'genome_name': seq.genome_name,
                  'feature_id': seq.feature_id,
                  'genome_id': seq.genome_id,
                  'patric_id': seq.patric_id,
                  'aa_length': seq.aa_length,
                  'refseq_locus_tag': seq.refseq_locus_tag
                }
              })

              def.resolve({
                map: map,
                alignment: alignment,
                // gblocks: gblocksOut,
                tree: fastTree
              })
            }, function (err) {
              def.reject('Unable to Complete FastTree: ' + err)
            })
          }, function (err) {
            def.reject('Unable to Complete GBLocks for Alignment: ' + err)
          })
        }, function (err) {
          def.reject('Unable to Complete Alignement: ' + err)
        })
      })
    }, function (err) {
      def.reject('Unable To Retreive Feature Data for MSA: ' + err)
    })
    return def.promise
  }
}
