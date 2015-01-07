var nconf = require('nconf');

var defaults =  {
	"http_port": 3001,

	collections: [
		"enzyme_class_ref",
		"gene_ontology_ref",
		"genome",
		"genome_feature",
		"genome_sequence",
		"host_resp",
		"id_ref",
		"misc_niaid_sgc",
		"pathway",
		"pathway_ref",
		"ppi",
		"protein_family_ref",
		"proteomics_experiment",
		"proteomics_peptide",
		"proteomics_protein",
		"sp_gene",
		"sp_gene_evidence",
		"sp_gene_ref",
		"taxonomy",
		"transcriptomics_experiment",
		"transcriptomics_gene",
		"transcriptomics_sample",
		"global"
	],

	indexImportLimits: {
		default: 25,
		genome_sequence: 100
	},

	queueDirectory: "/tmp/p3-index-queue",
	"solr": {
		"url": "http://localhost:8983/solr"
	}
}

module.exports = nconf.argv().env().file("./p3api.conf").defaults(defaults);
