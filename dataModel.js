var debug=require('debug')("p3api:dataModel");
var DataModel = require("dme/DataModel")
var implementation = require("./implementation/");
var schemas = require("./schemas");
var Store = require("dme/store/solr");
var conf = require('./config');
var Model = require("dme/model");
var RestrictiveFacet = require("dme/RestrictiveFacet");
var PublicFacet = require("./PublicFacet");
var UserFacet = require("./UserFacet");

// debug("schemas", schemas);

var FullModel = new DataModel({
	"genome": new Model("genome",schemas['genome'], new Store("genome", {url: conf.get("solr:url")}), implementation['genome']||{}),
	"enzyme_class_ref": new Model("enzyme_class_ref",schemas['enzyme_class_ref'], new Store("enzyme_class_ref", {url: conf.get("solr:url")}), implementation['enzyme_class_ref']||{}),
	"gene_ontology_ref": new Model("gene_ontology_ref",schemas['gene_ontology_ref'], new Store("gene_ontology_ref", {url: conf.get("solr:url")}), implementation['gene_ontology_ref']||{}),
	"genome_feature": new Model("genome_feature",schemas['genome_feature'], new Store("genome_feature", {url: conf.get("solr:url")}), implementation['genome_feature']||{}),	
	"genome_sequence": new Model("genome_sequence",schemas['genome_sequence'], new Store("genome_sequence", {url: conf.get("solr:url")}), implementation['genome_sequence']||{}),
	"host_resp": new Model("host_resp",schemas['host_resp'], new Store("host_resp", {url: conf.get("solr:url")}), implementation['host_resp']||{}),
	"id_ref": new Model("id_ref",schemas['id_ref'], new Store("id_ref", {url: conf.get("solr:url")}), implementation['id_ref']||{}),
	"misc_niaid_sgc": new Model("misc_niaid_sgc",schemas['misc_niaid_sgc'], new Store("misc_niaid_sgc", {url: conf.get("solr:url")}), implementation['misc_niaid_sgc']||{}),
	"p3_identifiers": new Model("p3_identifiers",schemas['p3_identifiers'], new Store("p3_identifiers", {url: conf.get("solr:url")}), implementation['p3_identifiers']||{}),
	"pathway": new Model("pathway",schemas['pathway'], new Store("pathway", {url: conf.get("solr:url")}), implementation['pathway']||{}),
	"ppi": new Model("ppi",schemas['ppi'], new Store("ppi", {url: conf.get("solr:url")}), implementation['ppi']||{}),
	"protein_family_ref": new Model("protein_family_ref",schemas['protein_family_ref'], new Store("protein_family_ref", {url: conf.get("solr:url")}), implementation['protein_family_ref']||{}),
	"proteomics_experiment": new Model("proteomics_experiment",schemas['proteomics_experiment'], new Store("proteomics_experiment", {url: conf.get("solr:url")}), implementation['proteomics_experiment']||{}),
	"proteomics_peptide": new Model("proteomics_peptide",schemas['proteomics_peptide'], new Store("proteomics_peptide", {url: conf.get("solr:url")}), implementation['proteomics_peptide']||{}),
	"sp_gene": new Model("sp_gene",schemas['sp_gene'], new Store("sp_gene", {url: conf.get("solr:url")}), implementation['sp_gene']||{}),
	"sp_gene_evidence": new Model("sp_gene_evidence",schemas['sp_gene_evidence'], new Store("sp_gene_evidence", {url: conf.get("solr:url")}), implementation['sp_gene_evidence']||{}),
	"sp_gene_ref": new Model("sp_gene_ref",schemas['sp_gene_ref'], new Store("sp_gene_ref", {url: conf.get("solr:url")}), implementation['sp_gene_ref']||{}),
	"taxonomy": new Model("taxonomy",schemas['taxonomy'], new Store("taxonomy", {url: conf.get("solr:url")}), implementation['taxonomy']||{}),
	"transcriptomics_experiment": new Model("transcriptomics_experiment",schemas['transcriptomics_experiment'], new Store("transcriptomics_experiment", {url: conf.get("solr:url")}), implementation['transcriptomics_experiment']||{}),
	"transcriptomics_gene": new Model("transcriptomics_gene",schemas['transcriptomics_gene'], new Store("transcriptomics_gene", {url: conf.get("solr:url")}), implementation['transcriptomics_gene']||{}),
	"transcriptomics_sample": new Model("transcriptomics_sample",schemas['transcriptomics_sample'], new Store("transcriptomics_sample", {url: conf.get("solr:url")}), implementation['transcriptomics_sample']||{}),
});

exports.admin = FullModel;

exports.user = new DataModel({
	"genome": new UserFacet(FullModel.get("genome")),
	"enzyme_class_ref": new UserFacet(FullModel.get("enzyme_class_ref")),
	"gene_ontology_ref": new UserFacet(FullModel.get("gene_ontology_ref")),
	"genome_feature": new UserFacet(FullModel.get("genome_feature")),
	"genome_sequence": new UserFacet(FullModel.get("genome_sequence")),
	"host_resp": new UserFacet(FullModel.get("host_resp")),
	"id_ref": new UserFacet(FullModel.get("id_ref")),
	"misc_niaid_sgc": new UserFacet(FullModel.get("misc_niaid_sgc")),
	"p3_identifiers": new UserFacet(FullModel.get("p3_identifiers")),
	"pathway": new UserFacet(FullModel.get("pathway")),
	"ppi": new UserFacet(FullModel.get("ppi")),
	"protein_family_ref": new UserFacet(FullModel.get("protein_family_ref")),
	"proteomics_experiment": new UserFacet(FullModel.get("proteomics_experiment")),
	"proteomics_peptide": new UserFacet(FullModel.get("proteomics_peptide")),
	"sp_gene": new UserFacet(FullModel.get("sp_gene")),
	"sp_gene_ref": new UserFacet(FullModel.get("sp_gene_ref")),
	"sp_gene_evidence": new UserFacet(FullModel.get("sp_gene_evidence")),
	"taxonomy": new UserFacet(FullModel.get("taxonomy")),
	"transcriptomics_experiment": new UserFacet(FullModel.get("transcriptomics_experiment")),
	"transcriptomics_gene": new UserFacet(FullModel.get("transcriptomics_gene")),
	"transcriptomics_sample": new UserFacet(FullModel.get("transcriptomics_sample"))
})

exports.public = new DataModel({
	"genome": new PublicFacet(FullModel.get("genome")),
	"enzyme_class_ref": new PublicFacet(FullModel.get("enzyme_class_ref")),
	"gene_ontology_ref": new PublicFacet(FullModel.get("gene_ontology_ref")),
	"genome_feature": new PublicFacet(FullModel.get("genome_feature")),
	"genome_sequence": new PublicFacet(FullModel.get("genome_sequence")),
	"host_resp": new PublicFacet(FullModel.get("host_resp")),
	"id_ref": new PublicFacet(FullModel.get("id_ref")),
	"misc_niaid_sgc": new PublicFacet(FullModel.get("misc_niaid_sgc")),
	"p3_identifiers": new PublicFacet(FullModel.get("p3_identifiers")),
	"pathway": new PublicFacet(FullModel.get("pathway")),
	"ppi": new PublicFacet(FullModel.get("ppi")),
	"protein_family_ref": new PublicFacet(FullModel.get("protein_family_ref")),
	"proteomics_experiment": new PublicFacet(FullModel.get("proteomics_experiment")),
	"proteomics_peptide": new PublicFacet(FullModel.get("proteomics_peptide")),
	"sp_gene": new PublicFacet(FullModel.get("sp_gene")),
	"sp_gene_ref": new PublicFacet(FullModel.get("sp_gene_ref")),
	"sp_gene_evidence": new PublicFacet(FullModel.get("sp_gene_evidence")),
	"taxonomy": new PublicFacet(FullModel.get("taxonomy")),
	"transcriptomics_experiment": new PublicFacet(FullModel.get("transcriptomics_experiment")),
	"transcriptomics_gene": new PublicFacet(FullModel.get("transcriptomics_gene")),
	"transcriptomics_sample": new PublicFacet(FullModel.get("transcriptomics_sample"))
})

