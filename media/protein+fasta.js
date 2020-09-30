const EventStream = require('event-stream')
const LineWrap = require('../util/linewrap')
const { getSequenceByHash, getSequenceDictByHash } = require('../util/featureSequence')
const SEQUENCE_BATCH = 200

function formatFASTA (doc) {
  let fasta_id
  if (doc.annotation === 'PATRIC') {
    fasta_id = `${doc.patric_id}|${(doc.refseq_locus_tag ? (doc.refseq_locus_tag + '|') : '') + (doc.alt_locus_tag ? (doc.alt_locus_tag + '|') : '')}`
  } else if (doc.annotation === 'RefSeq') {
    fasta_id = `gi|${doc.gi}|${(doc.refseq_locus_tag ? (doc.refseq_locus_tag + '|') : '') + (doc.alt_locus_tag ? (doc.alt_locus_tag + '|') : '')}`
  }
  const header = `>${fasta_id}   ${doc.product}   [${doc.genome_name} | ${doc.genome_id}]\n`
  return header + ((doc.sequence) ? LineWrap(doc.sequence, 60) : '') + '\n'
}

module.exports = {
  contentType: 'application/protein+fasta',
  serialize: async function (req, res, next) {
    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.fasta')
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        // let docCount = 0
        let head

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        results.stream.pipe(EventStream.map(function (data, callback) {
          if (!head) {
            head = data
            callback()
          } else {
            getSequenceByHash(data.aa_sequence_md5).then((seq) => {
              data.sequence = seq
              res.write(formatFASTA(data))
              // docCount++
              callback()
            }).catch((err) => {
              next(new Error(err))
            })
          }
        })).on('end', function () {
          res.end()
        })
      }, (error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else {
      if (res.results && res.results.response && res.results.response.docs) {
        const docs = res.results.response.docs
        const numFound = Math.min(res.results.response.numFound, docs.length) // query results can have lesser then it matched

        // fetch sequences by batch and create a global dictionary
        let sequenceDict = {}
        for (let i = 0, len = Math.ceil(numFound / SEQUENCE_BATCH); i < len; i++) {
          const start = i * SEQUENCE_BATCH
          const end = Math.min((i + 1) * SEQUENCE_BATCH, numFound)
          const md5Array = []
          for (let j = start; j < end; j++) {
            if (docs[j] && docs[j].aa_sequence_md5 && docs[j].aa_sequence_md5 !== '' && !sequenceDict.hasOwnProperty(docs[j].aa_sequence_md5)) {
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
