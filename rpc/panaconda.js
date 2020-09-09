const debug = require('debug')('p3api-server:panaconda')
const ChildProcess = require('child_process')
const Config = require('../config')
const { httpRequest } = require('../util/http')

function runQuery (query, opts) {
  return httpRequest({
    port: Config.get('http_port'),
    path: '/genome_feature/',
    method: 'POST',
    headers: {
      'content-type': 'application/rqlquery+x-www-form-urlencoded',
      'accept': 'text/tsv',
      'Authorization': opts.token || ''
    }
  }, query)
}

function buildGraph (annotations, opts) {
  return new Promise((resolve, reject) => {
    const d = []
    let errorClosed

    debug('Run Panaconda')
    const child = ChildProcess.spawn('python',
      [ '/disks/patric-common/runtime/bin/fam_to_graph.py',
        `--${opts.alpha}`, '--layout', '--ksize', opts.ksize, '--diversity', opts.diversity, '--context', opts.context],
      {
        stdio: [
          'pipe',
          'pipe', // pipe child's stdout to parent
          'pipe'
        ]
      })

    child.stdout.on('data', (data) => {
      d.push(data.toString())
    })

    child.stderr.on('data', (errData) => {
      debug('Panaconda STDERR Data: ', errData.toString())
    })

    child.on('error', (err) => {
      errorClosed = true
      reject(err)
    })

    child.on('close', (code) => {
      debug(`Panaconda process closed. ${code}`)

      if (!errorClosed) {
        resolve(d.join(''))
      }
    })

    child.stdin.write(annotations, 'utf8')
    child.stdin.end()
  })
}

module.exports = {
  requireAuthentication: false,
  validate: function (params, req, res) {
    return params && params[0] && params[1] && params[0].length > 1 && params[1].length > 1
  },
  execute: function (params, req, res) {
    return new Promise((resolve, reject) => {
      const query = params[0]
      const alpha = params[1]
      const ksize = params[2]
      const context = params[3]
      const diversity = params[4]
      const opts = { req: req, user: req.user, token: req.headers.authorization, alpha: alpha, ksize: ksize, context: context, diversity: diversity }

      runQuery(query, opts).then((annotations) => {
        buildGraph(annotations, opts).then((graph) => {
          resolve({ 'graph': graph })
        }, (err) => {
          reject(new Error(`Failure to build pg-graph: ${err}`))
        })
      }, (err) => {
        reject(new Error(`Unable To retreive annotations for pg-graph: ${err}`))
      })
    })
  }
}
