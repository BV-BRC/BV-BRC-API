var defer = require('promised-io/promise').defer;
var MSA = require("./rpc/msa");
var Cluster = require("./rpc/cluster");
var ProteinFamily = require("./rpc/proteinFamily");

module.exports = {
	"multipleSequenceAlignment": MSA,
	"proteinFamily": ProteinFamily,
	"cluster": Cluster
};