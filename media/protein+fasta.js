var debug = require('debug')('p3api-server:media/protein+fasta')
var when = require('promised-io/promise').when
var es = require('event-stream')
var wrap = require('../util/linewrap')
const Defer = require('promised-io/promise').defer
const All = require('promised-io/promise').all
const getSequenceByHash = require('../util/featureSequence')

function serializeRow (type, o) {
  const def = new Defer()
  var fasta_id
  if (o.feature_type === 'source') {
    def.resolve('')
    return def.promise
  }
  if (o.annotation === 'PATRIC') {
    fasta_id = o.patric_id + '|' + (o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')
  } else if (o.annotation === 'RefSeq') {
    fasta_id = 'gi|' + o.gi + '|' + (o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')
  }
  var row = '>' + fasta_id + '   ' + o.product + '   [' + o.genome_name + ' | ' + o.genome_id + ']\n'

  if (o.aa_sequence_md5) {
    when(getSequenceByHash(o.aa_sequence_md5), (seq) => {
      row = row + wrap(seq, 60) + '\n'
      def.resolve(row)
    }, (err) => {
      def.reject(err)
    })
  } else {
    def.resolve(row)
  }
  return def.promise
}

module.exports = {
  contentType: 'application/protein+fasta',
  serialize: function (req, res, next) {
    // debug("application/protein+fastahandler");

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.fasta')
    }

    if (req.call_method === 'stream') {
      when(res.results, function (results) {
        // debug("res.results: ", results);
        var docCount = 0
        var head

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        results.stream.pipe(es.map(function (data, callback) {
          // debug("STREAM DATA: ", data);
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
        const arrayOfPromises = res.results.response.docs.map(function (o) {
          return serializeRow(req.call_collection, o)
        })
        All(arrayOfPromises).then((array) => {
          array.forEach((row) => {
            res.write(row)
          })
          res.end()
        })
      } else {
        res.end()
      }
    }
  }
}
