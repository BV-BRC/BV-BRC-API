define([
    'intern!object',
    'intern/chai!assert',
    'intern/dojo/request',
], function (registerSuite, assert, request) {
	var suite = {
		name: "SOLR Data Query"
	}

	var basicQueries = [
		["&q=*:*&rows=10", function(data){ /*console.log("data: ", data);*/assert.strictEqual(data.response.docs.length,10) }]
	]

	var dataModel = {
		"genome": {
			queries: []
		},
		"enzyme_class_ref": {},
		"gene_ontology_ref": {},
		"genome_feature": {
			queries: []
		},

		"genome_sequence": {},
		"host-resp": {},
		"id_ref": {},
		"misc_niaid_gsc": {},
		"pathway": {},
		"pathway_ref": {},
		"ppi": {},
		"protein_family_ref": {},
		"proteomics_experiment": {},
		"proteomics_peptide": {},
		"proteomics_protein": {},
		"sp_gene": {},
		"sp_gene_evidence": {},
		"sp_gene_ref": {},
		"taxonomy": {
			queries: []

		},
		"transcriptomics_experiment": {},
		"transcriptomics_gene": {},
		"transcriptomics_sample": {}
	}

	var filter=[
		"user","collection","client", "genome_sequence","host-resp","misc_niaid_gsc",
		"proteomics_peptide", "proteomics_protein","proteomics_experiment"
	];

	Object.keys(dataModel).filter(function(x){return filter.indexOf(x)==-1}).forEach(function(model) {
		var Model = dataModel[model];	
		var queries = Model.queries?basicQueries.concat(Model.queries):basicQueries;
		queries.forEach(function(bq){
			var query = bq[0];
			var handler=bq[1];
			suite["GET /"+model +"/?"+ query] = function(){
				var dfd = this.async(120000);
				request('http://localhost:3001/' + model + '/?' + query,{headers:{accept:"application/solr+json","content-type":"application/solrquery+x-www-form-urlencoded"},handleAs:"json"}).then(dfd.callback(handler),dfd.reject.bind(dfd));
				return dfd;
			}
		});
	});

	Object.keys(dataModel).filter(function(x){return filter.indexOf(x)==-1}).forEach(function(model) {
		var Model = dataModel[model];	
		var queries = Model.queries?basicQueries.concat(Model.queries):basicQueries;
		queries.forEach(function(bq){
			var query = bq[0];
			var handler=bq[1];
			suite["POST /"+model +"/"+ query] = function(){
				var dfd = this.async(120000);
				request('http://localhost:3001/' + model + '/',{method: "POST", headers:{accept:"application/solr+json","content-type":"application/solrquery+x-www-form-urlencoded"},handleAs:"json",data:query}).then(dfd.callback(handler),dfd.reject.bind(dfd));
				return dfd;
			}
		});
	});

	registerSuite(suite);	
});
