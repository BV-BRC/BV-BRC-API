const MSA = require('./rpc/msa')
const Cluster = require('./rpc/cluster')
const ProteinFamily = require('./rpc/proteinFamily')
const Subsystem = require('./rpc/subSystem.js')
const TranscriptomicsGene = require('./rpc/transcriptomicsGene')

module.exports = {
  'multipleSequenceAlignment': MSA,
  'proteinFamily': ProteinFamily,
  'subSystem': Subsystem,
  'transcriptomicsGene': TranscriptomicsGene,
  'cluster': Cluster
}
