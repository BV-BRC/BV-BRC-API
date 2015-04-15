define([
    'intern!object',
    'intern/chai!assert',
    'intern/dojo/request',
], function (registerSuite, assert, request) {
	var suite = {
		name: "Data Query"
	}

	var basicQueries = [
		["?&limit(10)", function(data){ assert.strictEqual(data.length,10) }]
	]

	var dataModel = {
		"genome": {
			queries: [
				["?eq(taxon_lineage_ids,1386)&limit(10)", function(data) { assert.strictEqual(data.length,10) }],
				["?eq(taxon_lineage_ids,1386)&limit(1)&select(genome_id,genome_name)", function(data) { 
					assert.strictEqual(data.length>0,true, "Query returned 0 results")
					var d = data[0];
					assert.isDefined(d.genome_id);
					assert.isDefined(d.genome_name);
					assert.isUndefined(d.kingdom);
					assert.equal(Object.keys(d).length,2);
				}],
//				["?exists(genome_name)&limit(1)&select(genome_id,genome_name)", function(data) { 
//					assert.strictEqual(data.length>0,true, "Query returned 0 results")
//					var d = data[0];
//					assert.isDefined(d.genome_id);
//					assert.isDefined(d.genome_name);
//					assert.isUndefined(d.kingdom);
//					assert.equal(Object.keys(d).length,2);
//				}]
		
			]
		},
//		"enzyme_class_ref": {},
//		"gene_ontology_ref": {},
		"genome_feature": {
			queries: [
				["?gt(na_length,968107)&lt(na_length,968109)&limit(10)", function(data) { 
					var d = data[0];
					assert.equal(d.na_length,968108);
				}],
				["?in(feature_id,(PATRIC.992186.3.NZ_AFER01000002.source.1.968108.fwd,PATRIC.992186.3.NZ_AFER01000001.source.1.3139278.fwd,PATRIC.992186.3.NZ_AFER01000003.source.1.110310.fwd))", function(data){
					assert.equal(data.length,3);
				}],
				["?eq(feature_id,PATRIC.992186.3.NZ_AFER01000002.source.1.968108.fwd)", function(data){
					var d = data[0];
					assert.equal(d.feature_id,"PATRIC.992186.3.NZ_AFER01000002.source.1.968108.fwd");
				}]
			]

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
			queries: [
				["?eq(taxon_name,bac)&limit(10)", function(data) { 
					var re = /bac/gi;
					data.forEach(function(d){
						var matches = d.taxon_name.match(re);
						assert.equal((matches && matches.length>0),true);
					});
				}],
				["?eq(taxon_name,trichormus+vari)&limit(10)", function(data) { 
					var re = /trichormus\ vari/gi;
					data.forEach(function(d){
						var matches = d.taxon_name.match(re);
						assert.equal((matches && matches.length>0),true);
					});
				}],


				["?eq(lineage_ids,1165)&limit(10)", function(data) { 
					data.forEach(function(d){
						assert.equal(d.lineage_ids.indexOf(1165)>=0, true)
					});
				}]
			]

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
			suite["/"+model +"/"+ query] = function(){
				var dfd = this.async(120000);
				request('http://localhost:3001/' + model + '/' + query,{headers:{accept:"application/json"},handleAs:"json"}).then(dfd.callback(handler),dfd.reject.bind(dfd));
				return dfd;
			}
		});
	});
	/*
	Object.keys(dataModel).filter(function(x){return filter.indexOf(x)==-1}).forEach(function(model) {
		var Model = dataModel[model];	
		suite["/"+model +" range-header"] = function(){
			var dfd = this.async(120000);
			var req = request('http://localhost:3001/' + model + '/',{headers:{range: "items=5-10", accept:"application/json"},handleAs:"json"})
			req.response.then(function(response){
				var header = response.getHeader("content-range");
				var parts = header.split(" ");
				try {
					assert.strictEqual(parts[0],"items");
					var otherp = parts[1].split("/");
					assert.strictEqual(otherp[0],"5-10");
					assert.operator(otherp[1],">",500);
					dfd.resolve(true);
				}catch(err){ dfd.reject(err); }
			},dfd.reject.bind(dfd));
			return dfd;
		}
	});
	*/
//	console.log("Register Suite: ", suite);
	registerSuite(suite);	
});
