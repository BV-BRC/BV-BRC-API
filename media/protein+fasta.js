const debug = require('debug')('p3api-server:media/protein+fasta')
const when = require('promised-io/promise').when
const es = require('event-stream')
const wrap = require('../util/linewrap')
const getSequenceByHash = require('../util/featureSequence').getSequenceByHash
const getSequenceDictByHash = require('../util/featureSequence').getSequenceDictByHash
const SEQUENCE_BATCH = 500
currentContext = 20

function formatFASTA (o) {
  let fasta_id
  if (o.annotation === 'PATRIC') {
    fasta_id = `${o.patric_id}|${(o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')}`
  } else if (o.annotation === 'RefSeq') {
    fasta_id = `gi|${o.gi}|${(o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')}`
  }
  const header = `>${fasta_id}   ${o.product}   [${o.genome_name} | ${o.genome_id}]\n`
  return header + ((o.sequence) ? wrap(o.sequence, 60) : '') + '\n'
}

module.exports = {
  contentType: 'application/protein+fasta',
  serialize: async function (req, res, next) {
    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.fasta')
    }

    if (req.call_method === 'stream') {
      when(res.results, function (results) {
        let docCount = 0
        let head

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        results.stream.pipe(es.map(function (data, callback) {
          if (!head) {
            head = data
            callback()
          } else {
            getSequenceByHash(data.aa_sequence_md5).then((seq) => {
              data.sequence = seq
              res.write(formatFASTA(data))
              docCount++
              callback()
            }).catch((err) => {
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
        const docs = res.results.response.docs
        const numFound = res.results.response.numFound

        // fetch sequences by batch and create a global dictionary
        let sequenceDict = {}
        for (let i = 0, len = Math.ceil(numFound / SEQUENCE_BATCH); i < len; i++) {
          const start = i * SEQUENCE_BATCH
          const end = Math.min((i + 1) * SEQUENCE_BATCH, numFound)
          const md5Array = []
          for (let j = start; j < end; j++) {
            if (docs[j] && docs[j].aa_sequence_md5 && docs[j].aa_sequence_md5 !== '') {
              md5Array.push(docs[j].aa_sequence_md5)
            }
          }

          const dict = await getSequenceDictByHash(md5Array)
          sequenceDict = Object.assign(sequenceDict, dict)

          // format as it goes
          for (let j = start; j < end; j++) {
            if (docs[j] && docs[j].aa_sequence_md5) {
              docs[j].sequence = sequenceDict[docs[j].aa_sequence_md5]
            }
            res.write(formatFASTA(docs[j]))
          }
        }
      }
      res.end()
    }
  }
}
