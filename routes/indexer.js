const Express = require('express')
const Router = Express.Router({
  strict: true,
  mergeParams: true
})
const { httpsGet } = require('../util/http')
const Config = require('../config')
const AuthMiddleware = require('../middleware/auth')
const HttpParamsMiddleware = require('../middleware/http-params')
const debug = require('debug')('p3api-server:route/indexer')

const Formidable = require('formidable')
const Uuid = require('uuid')
const Fs = require('fs-extra')
const Path = require('path')
const QUEUE_DIRECTORY = Config.get('queueDirectory')
const Queue = require('file-queue').Queue

const Url = require('url')
const SOLR_URL = Config.get('solr').url
const parsedSolrUrl = Url.parse(SOLR_URL)

const Http = require('http')
const solrAgentConfig = Config.get('solr').shortLiveAgent
//const solrAgent = new Http.Agent(solrAgentConfig)

const Web = require('../web');
var solrAgent = Web.getSolrShortLiveAgent();


debug('Queue Directory: ', QUEUE_DIRECTORY)
let queue
Fs.mkdirs(Path.join(QUEUE_DIRECTORY, 'file_data'), function (err) {
  if (err) {
    debug('Error Creating Index Directory Structure: ', err)
    return
  }
  Fs.mkdirs(Path.join(QUEUE_DIRECTORY, 'history'), function (err) {
    if (err) {
      debug('Error Creating Index History Directory: ', err)
      return
    }
    Fs.mkdirs(Path.join(QUEUE_DIRECTORY, 'errors'), function (err) {
      if (err) {
        debug('Error Creating Index Error Directory: ', err)
        return
      }

      queue = new Queue(QUEUE_DIRECTORY, function (err) {
        if (err) {
          debug('error: ', err)
          return
        }
        debug('Created Queue.')
      })
    })
  })
})

Router.use(HttpParamsMiddleware)
Router.use(AuthMiddleware)

Router.get('/:id', function (req, res, next) {
  debug('Read Data from History: ', Path.join(QUEUE_DIRECTORY, 'history', req.params.id))
  Fs.readJson(Path.join(QUEUE_DIRECTORY, 'history', req.params.id), function (err, data) {
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
              Fs.removeSync(fileDirPath)
            } else {
              // as is, state is submitted
              debug('Not all cores indexed')
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
  return new Promise((resolve, reject) => {
    const cores = ['genome_sequence', 'genome_feature', 'genome']
    const check_cores = cores.map((core) => {
      // this should be a direct call to bypass the auth check
      return httpsGet({
        hostname: parsedSolrUrl.hostname,
        port: parsedSolrUrl.port,
	auth: parsedSolrUrl.auth,
        agent: solrAgent,
        path: `/solr/${core}/select?q=genome_id:${genome_id}&rows=0&wt=json`
      }).then((body) => {
        const data = JSON.parse(body)
        debug(`checking index status for ${genome_id}: [${core}] ${data.response.numFound} row(s) found`)
        return (data['response']['numFound'] > 0)
      })
    })
    Promise.all(check_cores).then((results) => {
      resolve(results.every((hasIndexed) => hasIndexed))
    }, (err) => {
      reject(err)
    })
  })
}

function updateHistory (id, data) {
  return new Promise((resolve, reject) => {
    data.state = 'indexed'
    data.indexCompletionTime = new Date()

    Fs.writeJson(Path.join(QUEUE_DIRECTORY, 'history', id), data, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve(data)
    })
  })
}

Router.post('/:type', [
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
    const form = new Formidable.IncomingForm()
    const qid = Uuid.v4()
    Fs.mkdirs(Path.join(QUEUE_DIRECTORY, 'file_data', qid), function (err) {
      if (err) {
        debug('Error creating output directory for index files to be queued: ', Path.join(QUEUE_DIRECTORY, 'file_data', qid))
        res.end(500)
        return
      }
      form.keepExtensions = true
      form.uploadDir = Path.join(QUEUE_DIRECTORY, 'file_data', qid)
      form.multiples = true
      debug('Begin parse')
      form.parse(req, function (err, fields, files) {
        if (err) {
          console.error(`Unable to parse form: ${err}`, req)
          res.error(`Unable to parse form: ${err}`)
          res.end(500)
          return
        }
        const d = { id: qid, type: req.params.type, user: req.user, options: fields, files: {} }

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

          Fs.writeJson(Path.join(QUEUE_DIRECTORY, 'history', qid), d, function (err) {
            if (err) {
              console.error(`Unable to update history for ${qid}: ${err}`)
              res.end(500)
              return
            }
            res.set('content-type', 'application/json')
            res.send(JSON.stringify({ id: qid, state: 'queued', queueTime: d.queueTime }))
            res.end()
          })
        })
      })
    })
  }
])

// fallback. return number of genomes in queue
Router.get('/', function (req, res, next) {
  queue.length((err, length) => {
    if (err) {
      console.error(`Unable to read queue info.`)
    }
    respondWithData(res, { 'genomesInQueue': length })
  })
})

module.exports = Router
