const Config = require('../config')
const TREE_DIRECTORY = Config.get('treeDirectory')
const Path = require('path')
const Fs = require('fs')

function checkForFiles (list) {
  return new Promise((resolve, reject) => {
    const id = list.pop()
    const file = Path.join(TREE_DIRECTORY, `${id}.newick`)

    if (Fs.existsSync(file)) {
      resolve(file)
    } else {
      if (!list || list.length < 1) {
        reject(new Error('Newick Not Found'))
      } else {
        checkForFiles(list)
          .then((f) => resolve(f))
          .catch((e) => reject(e))
      }
    }
  })
}

module.exports = {
  contentType: 'application/newick',
  serialize: function (req, res, next) {
    if (req.call_collection === 'taxonomy' && req.call_method === 'get') {
      if (res.results && res.results.doc) {
        const lineageIds = res.results.doc.lineage_ids
        // console.log(`checking lineage Ids: ${lineageIds}`)
        checkForFiles(lineageIds)
          .then((file) => {
            Fs.createReadStream(file).pipe(res)
          })
          .catch((err) => {
            console.log(`Unable to handle media type newick. ${err}`)
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end("{}")
          })
      } else {
        next(new Error(`Invalid Resposponse: ${res.results}`))
      }
    } else {
      next(new Error('Cannot retrieve newick formatted data from this source'))
    }
  }
}
