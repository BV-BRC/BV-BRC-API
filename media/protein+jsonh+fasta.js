const EventStream = require('event-stream')
const LineWrap = require('../util/linewrap')
const { getSequenceByHash, getSequenceDictByHash } = require('../util/featureSequence')
const transforms = require("async-transforms")
const SEQUENCE_BATCH = 200

function formatFASTA (doc) {
  let fasta_id
  if (doc.annotation === 'PATRIC') {
    fasta_id = `${doc.patric_id}|${(doc.refseq_locus_tag ? (doc.refseq_locus_tag + '|') : '') + (doc.alt_locus_tag ? (doc.alt_locus_tag + '|') : '')}`
  } else if (doc.annotation === 'RefSeq') {
    fasta_id = `gi|${doc.gi}|${(doc.refseq_locus_tag ? (doc.refseq_locus_tag + '|') : '') + (doc.alt_locus_tag ? (doc.alt_locus_tag + '|') : '')}`
  }
  const header = `>${fasta_id} ${JSON.stringify(doc)}]\n`
  return header + ((doc.sequence) ? LineWrap(doc.sequence, 60) + '\n' : '')
}

module.exports = {
  contentType: 'application/protein+jsonh+fasta',
  serialize: async function (req, res, next) {
    if (req.isDownload) {
      res.attachment('BVBRC_' + req.call_collection + '.fasta')
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        // let docCount = 0
        let head=false
        const buffer = {data: []}

        var tfunc = async function (data) {
            if (!head){ head = true; return;}
            if (req.call_collection === 'genome_feature') {
              buffer.data.push(data)
              if (buffer.data.length>=SEQUENCE_BATCH){
                var hashes = buffer.data.map((d)=>{ return d.aa_sequence_md5; })
                var seqhash = await getSequenceDictByHash(hashes,req)
                buffer.data.forEach((d)=>{
                  if (!d.aa_sequence_md5 || !seqhash[d.aa_sequence_md5]){
                    console.log("D: ", d)
                    console.error(`Download: Unable to find sequence for ${d.aa_sequence_md5}`)
                    res.write(formatFASTA(d))
                    return
                  }
                  d.sequence=seqhash[d.aa_sequence_md5]
                  res.write(formatFASTA(d))
                })
                buffer.data=[]
              }
            } else if (req.call_collection === 'genome_sequence') {
              res.write(formatFASTA(data))
            }
        }
        results.stream.pipe(transforms.map(tfunc,{order: true, tasks:1}))
        .on('end', function () {
          if (buffer.data.length>0){
            var hashes = buffer.data.map((d)=>{ return d.aa_sequence_md5; })
            getSequenceDictByHash(hashes,req).then((seqhash)=>{
              buffer.data.forEach((d)=>{
                if (!d.aa_sequence_md5 || !seqhash[d.aa_sequence_md5]){
                  console.log("D: ", d)

                  console.error(`Download: Unable to find sequence for ${d.aa_sequence_md5}`)
                  res.write(formatFASTA(d))
                  return;
                }
                // console.log("d.na_sequence_md5", d.na_sequence_md5)
                d.sequence=seqhash[d.aa_sequence_md5]
                res.write(formatFASTA(d))
              })
              res.end()
            })
          }else{
            res.end()
          }         
        }).resume()
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
