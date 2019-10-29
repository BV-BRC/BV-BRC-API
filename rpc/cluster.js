const Deferred = require('promised-io/promise').Deferred
const when = require('promised-io/promise').when
const debug = require('debug')('p3api-server:cluster')
const spawn = require('child_process').spawn
const Temp = require('temp')
const fs = require('fs-extra')

function runCluster (data, config, opts) {
  const def = new Deferred()
  let errorClosed

  debug('Run Cluster')

  const tempFileInput = Temp.path({prefix: 'cluster.', suffix: '.input'})
  const tempFileBase = tempFileInput.replace('.input', '')
  const tempFileOutput = tempFileBase + '.cdt'
  const tempFilePath = tempFileBase.split('cluster.')[0]

  debug('Cluster Temp File Input: ', tempFileInput, 'at', tempFilePath)

  fs.outputFile(tempFileInput, data, function (err) {
    if (err) {
      def.reject('Unable to write input data to', tempFileInput)
      return
    }

    const child = spawn('cluster',
      ['-f', tempFileInput, '-u', tempFileBase,
        '-g', config.g || 1, '-e', config.e || 2, '-m', config.m || 'a'],
      {
        cwd: tempFilePath,
        stdio: [
          'pipe',
          'pipe',
          'pipe'
        ]
      })

    setTimeout(function () {
      if (child.exitCode === 0) {
        debug(`child process ${child.pid} is finished normally`)
      } else {
        debug('Cluster timed out!')
        errorClosed = true
        def.reject('Timed out. Cluster took more than 20 mins. Please reduce the data set and try again.')
        child.kill('SIGHUP')
      }
    }, 1000 * 60 * 20)

    child.stderr.on('data', function (errData) {
      debug('Cluster STDERR Data: ', errData.toString())
    })

    child.on('error', function (err) {
      errorClosed = true
      def.reject(err)
    })

    child.on('close', function (code) {
      debug('Cluster Process closed.', code)

      if (!errorClosed) {
        // read result file and return
        fs.readFile(tempFileOutput, 'utf8', function (err, data) {
          if (err) {
            def.reject('Unable to read ' + tempFileOutput)
            return
          }

          const output = {}
          const rows = []
          let count = 0
          const lines = data.split('\n')

          lines.forEach(line => {
            line = line.trim()
            if (!line || line.length === 0) return

            const tabs = line.split('\t')
            if (count === 0) {
              const columns = []
              for (let i = 4; i < tabs.length; i++) {
                columns.push(tabs[i].split('-')[0])
              }
              output.columns = columns
            }
            if (count >= 3) {
              rows.push(tabs[1])
            }
            count++
          })

          output.rows = rows

          def.resolve(output)
        })
      }

      // remove all related files
      fs.remove(tempFileBase + '.*', function (err) {
        if (err) return debug(err)

        debug('success removed temp files: ', tempFileBase + '.*')
      })
    })
  })

  return def.promise
}

module.exports = {
  requireAuthentication: false,
  validate: function (params, req, res) {
    // validate parameters here
    return params && params[0]
  },
  execute: function (params, req, res) {
    const def = new Deferred()

    const data = params[0]
    const config = params[1]
    const opts = {req: req, user: req.user}

    when(runCluster(data, config, opts), function (result) {
      def.resolve(result)
    }, function (err) {
      def.reject('Unable to Complete Cluster: ' + err)
    })

    return def.promise
  }
}
