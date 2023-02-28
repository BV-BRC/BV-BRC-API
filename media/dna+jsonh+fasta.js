const EventStream = require('event-stream')
const LineWrap = require('../util/linewrap')
const { getSequenceByHash, getSequenceDictByHash } = require('../util/featureSequence')
const SEQUENCE_BATCH = 200
const transforms = require("async-transforms")

function formatFASTAGenomeSequence (o) {
  const header = `>accn|${o.accession} ${JSON.stringify(o)}\n`
  return header + LineWrap(o.sequence, 60) + '\n'
}

function formatFASTAFeatureSequence (o) {
  let fasta_id
  if (o.annotation === 'PATRIC') {
    fasta_id = `${o.patric_id}|${(o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')}`
  } else if (o.annotation === 'RefSeq') {
    fasta_id = `gi|${o.gi}|${(o.refseq_locus_tag ? (o.refseq_locus_tag + '|') : '') + (o.alt_locus_tag ? (o.alt_locus_tag + '|') : '')}`
  }
  const seq = o.sequence
  delete o.sequence
  const header = `>${fasta_id} ${JSON.stringify(o)}\n`
  return header + ((seq) ? LineWrap(seq, 60) : '') + '\n'
}

module.exports = {
  contentType: 'application/dna+jsonh+fasta',
  serialize: async function (req, res, next) {
    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.fasta`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }
        let head=false;
        const buffer = {data: []}

        var tfunc = async function (data) {
            if (!head){ head = true; return;}
            if (req.call_collection === 'genome_feature') {
              buffer.data.push(data)
              if (buffer.data.length>=SEQUENCE_BATCH){
                var hashes = buffer.data.map((d)=>{ return d.na_sequence_md5; })
                // console.log("Get sequence batch")
                var seqhash = await getSequenceDictByHash(hashes,req)
                buffer.data.forEach((d)=>{
                  if (!d.na_sequence_md5 || !seqhash[d.na_sequence_md5]){
                    console.error(`Download: Unable to find sequence for ${d.na_sequence_md5}`)
                    res.write(formatFASTAFeatureSequence(d))
                    return
                  }
                  d.sequence=seqhash[d.na_sequence_md5]
                  res.write(formatFASTAFeatureSequence(d))
                })
                buffer.data=[]
              }
            } else if (req.call_collection === 'genome_sequence') {
              res.write(formatFASTAGenomeSequence(data))
            }
        }
        results.stream.pipe(transforms.map(tfunc,{order: true, tasks:1}))
        .on('end', function () {
          if (buffer.data.length>0){
            var hashes = buffer.data.map((d)=>{ return d.na_sequence_md5; })
            getSequenceDictByHash(hashes,req).then((seqhash)=>{
              buffer.data.forEach((d)=>{
                if (!d.na_sequence_md5 || !seqhash[d.na_sequence_md5]){
                  console.error(`Download: Unable to find sequence for ${d.na_sequence_md5}`)
                  res.write(formatFASTAFeatureSequence(d))
                  return;
                }
                // console.log("d.na_sequence_md5", d.na_sequence_md5)
                d.sequence=seqhash[d.na_sequence_md5]
                res.write(formatFASTAFeatureSequence(d))
              })
              res.end()
            })
          }else{
            res.end()
          }         
        }).resume() // this .resume() here is to address an issue with older node not triggering the 'end' event with new streaming setups
      }, (error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else {
      if (res.results && res.results.response && res.results.response.docs) {
        const docs = res.results.response.docs
        const numFound = Math.min(res.results.response.numFound, docs.length) // query results can have lesser then it matched

        if (req.call_collection === 'genome_feature') {
          // fetch sequences by batch and create a global dictionary
          let sequenceDict = {}
          for (let i = 0, len = Math.ceil(numFound / SEQUENCE_BATCH); i < len; i++) {
            const start = i * SEQUENCE_BATCH
            const end = Math.min((i + 1) * SEQUENCE_BATCH, numFound)
            const md5Array = []
            for (let j = start; j < end; j++) {
              if (docs[j] && docs[j].na_sequence_md5 && docs[j].na_sequence_md5 !== '' && !sequenceDict.hasOwnProperty(docs[j].aa_sequence_md5)) {
                md5Array.push(docs[j].na_sequence_md5)
              }
            }

            const dict = await getSequenceDictByHash(md5Array)
            sequenceDict = Object.assign(sequenceDict, dict)

            // format as it goes
            for (let j = start; j < end; j++) {
              if (docs[j] && docs[j].na_sequence_md5) {
                docs[j].sequence = sequenceDict[docs[j].na_sequence_md5]
              }
              res.write(formatFASTAFeatureSequence(docs[j]))
            }
          }
        } else if (req.call_collection === 'genome_sequence') {
          for (let i = 0, len = docs.length; i < len; i++) {
            res.write(formatFASTAGenomeSequence(docs[i]))
          }
        }
      }
      res.end()
    }
  }
}
