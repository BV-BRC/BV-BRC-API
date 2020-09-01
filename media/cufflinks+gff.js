const EventStream = require('event-stream')

function sanitize (val) {
  return val.replace(/;/g, '%3B').replace(/=/g, '%3D').replace(/&/g, '%26').replace(/,/g, '%2C')
}

function serializeRow (doc) {
  const row = []
  const row2 = []
  if (doc.feature_type === 'source') {
    doc.feature_type = 'region'
  }
  if (doc.feature_type === 'misc_RNA') {
    doc.feature_type = 'transcript'
  }

  if (doc.feature_type === 'region') {
    row.push(`##sequence-region\taccn|${o.accession}\t${o.start}\t${o.end}\n`)
    return
  }
  if (doc.feature_type === 'CDS') {
    row.push(`${doc.accession}\t${doc.annotation}\tgene\t${doc.start}\t${doc.end}\t.\t${doc.strand}\t0\t`)
    row2.push(`${doc.accession}\t${doc.annotation}\tCDS\t${doc.start}\t${doc.end}\t.\t${doc.strand}\t0\t`)
  } else {
    row.push(`${doc.accession}\t${doc.annotation}\t${doc.feature_type}\t${doc.start}\t${doc.end}\t.\t${doc.strand}\t0\t`)
  }

  switch (doc.annotation) {
    case 'PATRIC':
      row.push(`ID=${doc.patric_id}`)
      row.push(`;name=${doc.patric_id}`)
      if (row2.length > 0) {
        row2.push(`Parent=${doc.patric_id}`)
        row2.push(`;name=${doc.patric_id}`)
      }
      break
    case 'RefSeq':
      row.push(`ID=${doc.refseq_locus_tag}`)
      row.push(`;name=${doc.refseq_locus_tag}`)
      break
  }

  if (doc.refseq_locus_tag) {
    row.push(`;locus_tag=${doc.refseq_locus_tag}`)
  }

  if (doc.product) {
    row.push(`;product=${sanitize(doc.product)}`)
  }

  if (doc.go) {
    row.push(`;Ontology_term=${doc.go}`)
  }

  if (doc.ec) {
    row.push(`;ec_number=${doc.ec.join('|')}`)
  }
  let result = row.join('') + '\n'
  if (row2.length > 0) {
    result += row2.join('') + '\n'
  }
  return result
}

module.exports = {
  contentType: 'application/cufflinks+gff',
  serialize: function (req, res, next) {
    // console.log(`media type csv, call_method: ${req.call_method}`)

    if (req.isDownload) {
      res.attachment('PATRIC_' + req.call_collection + '.fasta')
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results]).then((vals) => {
        const results = vals[0]
        let docCount = 0
        let head

        if (!results.stream) {
          throw Error('Expected ReadStream in Serializer')
        }

        results.stream.pipe(EventStream.mapSync((data) => {
          if (!head) {
            head = data
          } else {
            if (docCount < 1) {
              res.write('##gff-version 3\n')
              res.write(`#Genome: ${data.genome_id}\t${data.genome_name}`)
              if (data.product) {
                res.write(' ' + data.product)
              }
            }
            res.write(serializeRow(data))
            docCount++
          }
        })).on('end', () => {
          res.end()
        })
      }, (error) => {
        next(new Error(`Unable to receive stream: ${error}`))
      })
    } else {
      if (res.results && res.results.response && res.results.response.docs && res.results.response.docs.length > 0) {
        res.write('##gff-version 3\n')
        res.write(`#Genome: ${res.results.response.docs[0].genome_id}\t${res.results.response.docs[0].genome_name}`)
        if (res.results.response.docs[0].product) {
          res.write(' ' + res.results.response.docs[0].product)
        }
        res.write('\n')
        res.results.response.docs.forEach((data) => {
          res.write(serializeRow(data))
        })
      }
      res.end()
    }
  }
}
