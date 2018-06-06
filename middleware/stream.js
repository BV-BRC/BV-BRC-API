
var streamableMediaTypes = [
  'application/json',
  'text/csv',
  'text/tsv',
  'application/dna+fasta',
  'application/protein+fasta',
  'application/sralign+dna+fasta',
  'application/gff',
  'application/cufflinks+gff'
]

module.exports.checkIfStreaming = function (req, res, next) {
  if (req.headers && req.headers.accept && streamableMediaTypes.indexOf(req.headers.accept) < 0) {
    return next()
  }

  if (req.isDownload && req.call_method === 'query') {
    req.call_method = 'stream'
  }
  next()
}
