const { streamWithBackpressure } = require('../util/streamWithBackpressure')

function serializeRow (doc) {
  const row = []
  if (doc.feature_type === 'source') {
    doc.feature_type = 'region'
  }
  if (doc.feature_type === 'misc_RNA') {
    doc.feature_type = 'transcript'
  }

  if (doc.feature_type === 'region') {
    row.push(`##sequence-region\taccn|${doc.accession}\t${doc.start}\t${doc.end}\n`)
    return row.join('')
  }

  row.push(`accn|${doc.accession}\t${doc.annotation}\t${doc.feature_type}\t${doc.start}\t${doc.end}\t.\t${doc.strand}\t0\t`)
  switch (doc.annotation) {
    case 'PATRIC':
      row.push(`ID=${doc.patric_id}`)
      break
    case 'RefSeq':
      row.push(`ID=${doc.refseq_locus_tag}`)
      break
  }

  if (doc.refseq_locus_tag) {
    row.push(`;locus_tag=${doc.refseq_locus_tag}`)
  }

  if (doc.product) {
    row.push(`;product=${doc.product}`)
  }

  if (doc.gene) {
    row.push(`;gene=${doc.gene}`)
  }

  if (doc.go) {
    row.push(`;Ontology_term=${doc.go}`)
  }

  if (doc.ec) {
    row.push(`;ec_number=${doc.ec.join('|')}`)
  }

  return row.join('') + '\n'
}

module.exports = {
  contentType: 'application/gff',
  serialize: function (req, res, next) {
    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.gff`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then(async (vals) => {
        const results = vals[0]

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        await streamWithBackpressure(results.stream, res, {
          onHeader: (firstDoc) => {
            let header = '##gff-version 3\n'
            header += `#Genome: ${firstDoc.genome_id}\t${firstDoc.genome_name}`
            if (firstDoc.product) {
              header += ` ${firstDoc.product}`
            }
            return header + '\n'
          },
          transform: (data) => serializeRow(data)
        })
      }).catch((error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else {
      if (res.results && res.results.response && res.results.response.docs && res.results.response.docs.length > 0) {
        res.write('##gff-version 3\n')
        const thisDoc = res.results.response.docs[0]
        res.write(`#Genome: ${thisDoc.genome_id}\t${thisDoc.genome_name}`)
        if (thisDoc.product) {
          res.write(` ${thisDoc.product}`)
        }
        res.write('\n')
        res.results.response.docs.forEach((o) => {
          res.write(serializeRow(o))
        })
      }
      res.end()
    }
  }
}
