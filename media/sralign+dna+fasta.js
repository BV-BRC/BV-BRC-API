var debug = require('debug')('p3api-server:media/sralign+dna+fasta')
var when = require('promised-io/promise').when
var es = require('event-stream')
var wrap = require('../util/linewrap')
const Defer = require('promised-io/promise').defer
const getSequenceByHash = require('../util/featureSequence')

function serializeRow (type, o) {
  const def = new Defer()
  if (type === 'genome_feature') {
    const row = '>' + o.patric_id + '|' + o.feature_id + ' ' + o.product
    if (o.na_sequence_md5) {
      when(getSequenceByHash(o.na_sequence_md5), (seq) => {
        def.resolve(row + wrap(seq, 60) + '\n')
      }, (err) => {
        def.reject(err)
      })
    }
  } else if (type === 'genome_sequence') {
    const row = '>' + o.accession + '   ' + o.description + '   ' + '[' + (o.genome_name || o.genome_id) + ']\n'
    def.resolve(row + wrap(o.sequence, 60) + '\n')
  } else {
    def.reject('Cannot query for application/sralign+dna+fasta from this data collection')
  }
  return def.promise
}

module.exports = {
  contentType: 'application/sralign+dna+fasta',
  serialize: async function (req, res, next) {
    debug('application/sralign+dna+fasta')

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.fasta')
      // res.set("content-disposition", "attachment; filename=patric_genomes.fasta");
    }

    if (req.call_method === 'stream') {
      when(res.results, function (results) {
        // debug("res.results: ", results);
        var docCount = 0
        var head

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        results.stream.pipe(es.mapSync(function (data, callback) {
          if (!head) {
            head = data
            callback()
          } else {
            // debug(JSON.stringify(data));
            when(serializeRow(req.call_collection, data), (row) => {
              res.write(row)
              docCount++
              callback()
            }, (err) => {
              debug(err)
            })
          }
        })).on('end', function () {
          debug('Exported ' + docCount + ' Documents')
          res.end()
        })
      })
    } else {
      if (res.results && res.results.response && res.results.response.docs) {
        for (let i = 0, len = res.results.response.docs.length; i < len; i++) {
          row = await serializeRow(req.call_collection, res.results.response.docs[i])
          res.write(row)
        }
      }
      res.end()
    }
  }
}
