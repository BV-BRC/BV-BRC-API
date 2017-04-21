const MSA = require("./rpc/msa");
const Panaconda = require("./rpc/panaconda");
const Cluster = require("./rpc/cluster");
const ProteinFamily = require("./rpc/proteinFamily");
const TranscriptomicsGene = require("./rpc/transcriptomicsGene");

module.exports = {
    "panaconda": Panaconda,
	"multipleSequenceAlignment": MSA,
	"proteinFamily": ProteinFamily,
	"transcriptomicsGene": TranscriptomicsGene,
	"cluster": Cluster
};
