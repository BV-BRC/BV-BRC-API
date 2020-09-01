const EventStream = require('event-stream')

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
    return
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
      res.attachment(`PATRIC_${req.call_collection}.gff`)
    }

    if (req.call_method === 'stream') {
      Promise.all([res.results], (vals) => {
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
            // debug(JSON.stringify(data));
            if (docCount < 1) {
              res.write('##gff-version 3\n')
              res.write(`#Genome: ${data.genome_id}\t${data.genome_name}`)
              if (data.product) {
                res.write(` ${data.product}`)
              }
            }
            res.write(serializeRow(req.call_collection, data))
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
