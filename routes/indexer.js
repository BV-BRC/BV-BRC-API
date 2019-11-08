var express = require('express')
var router = express.Router({
  strict: true,
  mergeParams: true
})
var Defer = require('promised-io/promise').defer
var when = require('promised-io/promise').when
var all = require('promised-io/promise').all
var Request = require('request')
var config = require('../config')
var authMiddleware = require('../middleware/auth')
var httpParams = require('../middleware/http-params')
var Queue = require('file-queue').Queue
var debug = require('debug')('p3api-server:route/indexer')
var formidable = require('formidable')
var uuid = require('uuid')
var fs = require('fs-extra')
var Path = require('path')

debug('Queue Directory: ', config.get('queueDirectory'))
var qdir = config.get('queueDirectory')
var queue
fs.mkdirs(Path.join(qdir, 'file_data'), function (err) {
  if (err) {
    debug('Error Creating Index Directory Structure: ', err)
    return
  }
  fs.mkdirs(Path.join(qdir, 'history'), function (err) {
    if (err) {
      debug('Error Creating Index History Directory: ', err)
      return
    }
    fs.mkdirs(Path.join(qdir, 'errors'), function (err) {
      if (err) {
        debug('Error Creating Index Error Directory: ', err)
        return
      }

      queue = new Queue(qdir, function (err) {
        if (err) {
          debug('error: ', err)
          return
        }
        debug('Created Queue.')
      })
    })
  })
})

router.use(httpParams)
router.use(authMiddleware)

router.use(function (req, res, next) {
  debug('req.path', req.path)
  // debug('req content-type', req.get('content-type'))
  // debug('accept', req.get('accept'))
  // debug('req.url', req.url)
  // debug('req.path', req.path)
  // debug('req.params:', JSON.stringify(req.params))
  next()
})

router.get('/:id', function (req, res, next) {
  debug('Read Data from History: ', Path.join(qdir, 'history', req.params.id))
  fs.readJson(Path.join(qdir, 'history', req.params.id), function (err, data) {
    if (err) {
      return next(err)
    }

    if (data.state === 'indexed') {
      respondWithData(res, data)
    } else {
      if (data.genomeId) {
        checkSolr(data.genomeId)
          .then((isAllIndexed) => {
            if (isAllIndexed) {
              updateHistory(req.params.id, data).then((data) => {
                respondWithData(res, data)
              })
              // now delete files
              const fileDirPath = Path.dirname(data.files['genome']['path'])
              debug(`Removing files from ${fileDirPath}`)
              fs.removeSync(fileDirPath)
            } else {
              // as is, state is submitted
              respondWithData(res, data)
            }
          }, (err) => {
            console.log(err)
            next(err)
          })
      } else {
        // before it submitted, state is queued
        respondWithData(res, data)
      }
    }
  })
})

function respondWithData (res, data) {
  res.set('content-type', 'application/json')
  res.send(JSON.stringify(data))
  res.end()
}

function checkSolr (genome_id) {
  const def = new Defer()
  const cores = ['genome_sequence', 'genome_feature', 'genome']
  const defs = cores.map((core) => {
    const url = `${config.get('solr').url}/${core}/select?q=genome_id:${genome_id}&rows=1&wt=json`
    // console.log(`${url}`)
    const def = new Defer()
    Request.get(url, (err, res, body) => {
      if (err) {
        def.reject(err)
        return def.promise
      }
      var data = JSON.parse(body)
      if (res.statusCode !== 200 || data.error) {
        def.reject(new Error(data.error.msg))
        return def.promise
      }
      debug(`checking index status for ${genome_id}: [${core}] ${data.response.numFound} row(s) found`)
      def.resolve(data['response']['numFound'] > 0)
    })
    return def.promise
  })
  when(all(defs), (results) => {
    def.resolve(results.every((hasIndexed) => hasIndexed))
  }, (err) => {
    def.reject(err)
  })
  return def.promise
}

function updateHistory (id, data) {
  const def = new Defer()

  data.state = 'indexed'
  data.indexCompletionTime = new Date()

  fs.writeJson(Path.join(qdir, 'history', id), data, function (err) {
    if (err) {
      def.reject(err)
      return def.promise
    }

    def.resolve(data)
  })
  return def.promise
}

router.post('/:type', [
  function (req, res, next) {
    if (!req.user) {
      res.sendStatus(401)
      return
    }

    if (!req.params || !req.params.type || (!req.params.type === 'genome')) {
      res.sendStatus(406)
      return
    }

    if (!queue) {
      res.send('Indexing is unavailable due to a queueing error')
      res.end(500)
      return
    }
    var form = new formidable.IncomingForm()
    var qid = uuid.v4()
    fs.mkdirs(Path.join(qdir, 'file_data', qid), function (err) {
      if (err) {
        debug('Error creating output directory for index files to be queued: ', Path.join(qdir, 'file_data', qid))
        res.end(500)
        return
      }
      form.keepExtensions = true
      form.uploadDir = Path.join(qdir, 'file_data', qid)
      form.multiples = true
      debug('Begin parse')
      form.parse(req, function (err, fields, files) {
        var d = {id: qid, type: req.params.type, user: req.user, options: fields, files: {}}

        Object.keys(files).forEach(function (type) {
          d.files[type] = files[type]
        })

        queue.push(d, function (err) {
          if (err) {
            res.error('Error Adding to queue: ' + err)
            res.end(500)
            return
          }
          d.state = 'queued'
          d.queueTime = new Date()

          fs.writeJson(Path.join(qdir, 'history', qid), d, function (err) {
            res.set('content-type', 'application/json')
            res.send(JSON.stringify({id: qid, state: 'queued', queueTime: d.queueTime}))
            res.end()
          })
        })
      })
    })
  }
])

// fallback. return number of genomes in queue
router.get('/', function (req, res, next) {
  queue.length((err, length) => {
    respondWithData(res, {'genomesInQueue': length})
  })
})

module.exports = router
