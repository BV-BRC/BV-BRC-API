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
        checkSolr(data.genomeId, data)
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

// Does the submission for a core actually contain any documents? An empty core
// (e.g. a genome with no called features) is submitted as an empty JSON array,
// which the index worker skips rather than posting. Such a core will have 0 rows
// in Solr forever, so it must count as "satisfied" rather than blocking
// completion. Read only a bounded prefix and look for the first object opener —
// an empty array ([] / [ ] / [\n]) has no '{'; any array with >=1 document does,
// within the first few bytes. This avoids parsing large feature files.
function submissionHasRows (fileEntry) {
  let entries = fileEntry
  if (!entries) { return false }
  if (!(entries instanceof Array)) { entries = [entries] }
  return entries.some((f) => {
    if (!f || !f.path) { return false }
    try {
      const fd = Fs.openSync(f.path, 'r')
      try {
        const buf = Buffer.alloc(8192)
        const n = Fs.readSync(fd, buf, 0, buf.length, 0)
        return buf.toString('utf8', 0, n).indexOf('{') !== -1
      } finally {
        Fs.closeSync(fd)
      }
    } catch (e) {
      // Can't read the file (already cleaned up, etc.) — assume no rows so a
      // missing empty core doesn't wedge the job in 'submitted' forever.
      debug(`submissionHasRows: cannot read ${f.path}: ${e.message}`)
      return false
    }
  })
}

function checkSolr (genome_id, data) {
  return new Promise((resolve, reject) => {
    const files = (data && data.files) || {}
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
        const parsed = JSON.parse(body)
        const numFound = parsed['response']['numFound']
        if (numFound > 0) {
          debug(`checking index status for ${genome_id}: [${core}] ${numFound} row(s) found`)
          return true
        }
        // 0 rows in Solr: satisfied only if the submission had no rows to index.
        const hadRows = submissionHasRows(files[core])
        debug(`checking index status for ${genome_id}: [${core}] 0 rows in Solr, submission ${hadRows ? 'HAD rows (pending)' : 'was empty (satisfied)'}`)
        return !hadRows
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
