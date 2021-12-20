const MSA = require('./rpc/msa')
const Cluster = require('./rpc/cluster')
const ProteinFamily = require('./rpc/proteinFamily')
const TranscriptomicsGene = require('./rpc/transcriptomicsGene')
const BiosetResult = require('./rpc/biosetResult')
const Panaconda = require('./rpc/panaconda')

module.exports = {
  'multipleSequenceAlignment': MSA,
  'proteinFamily': ProteinFamily,
  'transcriptomicsGene': TranscriptomicsGene,
  'biosetResult': BiosetResult,
  'cluster': Cluster,
  'panaconda': Panaconda
}
