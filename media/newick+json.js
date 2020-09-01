const Config = require('../config')
const TREE_DIRECTORY = Config.get('treeDirectory')
const Path = require('path')
const Fs = require('fs')

function checkForFiles (list) {
  return new Promise((resolve, reject) => {
    const id = list.pop()
    const file = Path.join(TREE_DIRECTORY, `${id}.json`)

    if (Fs.existsSync(file)) {
      resolve(file)
    } else {
      if (!list || list.length < 1) {
        reject(new Error('Json Not Found'))
      } else {
        checkForFiles(list)
          .then((f) => resolve(f))
          .catch((e) => reject(e))
      }
    }
  })
}

module.exports = {
  contentType: 'application/newick+json',
  serialize: function (req, res, next) {
    if (req.call_collection === 'taxonomy' && req.call_method === 'get') {
      if (res.results && res.results.doc) {
        const lineageIds = res.results.doc.lineage_ids
        checkForFiles(lineageIds)
          .then((file) => {
            Fs.createReadStream(file).pipe(res)
          })
          .catch((err) => {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end(err)
          })
      } else {
        next(new Error(`Invalid Resposponse: ${res.results}`))
      }
    } else {
      next(new Error('Cannot retrieve newick+json formatted data from this source'))
    }
  }
}
