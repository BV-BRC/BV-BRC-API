const MSA = require('./rpc/msa')
const Cluster = require('./rpc/cluster')
const ProteinFamily = require('./rpc/proteinFamily')
const TranscriptomicsGene = require('./rpc/transcriptomicsGene')

module.exports = {
  'multipleSequenceAlignment': MSA,
  'proteinFamily': ProteinFamily,
  'transcriptomicsGene': TranscriptomicsGene,
  'cluster': Cluster
}
