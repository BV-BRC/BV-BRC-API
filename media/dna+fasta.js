var debug = require('debug')('p3api-server:media/dna+fasta')
var when = require('promised-io/promise').when
var es = require('event-stream')
var wrap = require('../util/linewrap')
const Defer = require('promised-io/promise').defer
const getSequenceByHash = require('../util/featureSequence')

function serializeRow (type, o) {
  const def = new Defer()
  if (type === 'genome_feature') {
    var fasta_id, row
    if (o.annotation === 'PATRIC') {
      fasta_id = o.patric_id + '|' + (o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')
    } else if (o.annotation === 'RefSeq') {
      fasta_id = 'gi|' + o.gi + '|' + (o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')
    } else {
      throw Error('Unknown Annotation Type: ' + o.annotation)
    }

    row = '>' + fasta_id + '   ' + o.product + '   [' + o.genome_name + ' | ' + o.genome_id + ']\n'

    if (o.na_sequence_md5) {
      when(getSequenceByHash(o.na_sequence_md5), (seq) => {
        row = row + wrap(seq, 60) + '\n'
        def.resolve(row)
      }, (err) => {
        def.reject(err)
      })
    } else {
      def.resolve(row)
    }
    return def.promise
  } else if (type === 'genome_sequence') {
    row = '>accn|' + o.accession + '   ' + o.description + '   ' + '[' + (o.genome_name || '') + ' | ' + (o.genome_id || '') + ']\n'
    row = row + wrap(o.sequence, 60) + '\n'
    def.resolve(row)
    return def.promise
  } else {
    throw Error('Cannot serialize ' + type + ' to application/dna+fasta')
  }
}

module.exports = {
  contentType: 'application/dna+fasta',
  serialize: async function (req, res, next) {
    // debug("application/dna+fastahandler");

    if (req.isDownload) {
      // res.set("content-disposition", "attachment; filename=patric_genomes.fasta");
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
        for (let i = 0, len = res.results.response.docs.length; i < len; i++) {
          row = await serializeRow(req.call_collection, res.results.response.docs[i])
          res.write(row)
        }
        res.end()
      } else {
        res.end()
      }
    }
  }
}
