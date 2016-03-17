var defer = require('promised-io/promise').defer;
var MSA = require("./rpc/msa");
var Cluster = require("./rpc/cluster");

module.exports = {
	"multipleSequenceAlignment": MSA,
	"cluster": Cluster
}