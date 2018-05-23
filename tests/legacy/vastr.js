define([
    'intern!object',
    'intern/chai!assert',
    'intern/dojo/request',
    'intern/dojo/node!../data-model'
], function (registerSuite, assert, request,dataModel) {
	var suite = {
		name: "VASTR Queries"
	}


	var queries = [
		["genomesummary", "?or(eq(mlst,*),eq(serovar,*),eq(pathovar,*),eq(biovar,*))&select(genome_name,ncbi_tax_id,genome_info_id,biovar,serovar,pathovar,mlst)&limit(10,0)", function(data){ assert.strictEqual(data.length,10) }],
		["genomesummary", "?and(keyword(Escherichia%20coli),or(eq(mlst,*),eq(serovar,*),eq(pathovar,*),eq(biovar,*)))&select(genome_name,ncbi_tax_id,genome_info_id,biovar,serovar,pathovar,mlst)&limit(10,0)", function(data){ assert.strictEqual(data.length,10) }],
		["genomesummary", "?and(keyword(Escherichia%20coli),eq(pathovar,EHEC),or(eq(mlst,*),eq(serovar,*),eq(pathovar,*),eq(biovar,*)))&select(genome_name,ncbi_tax_id,genome_info_id,biovar,serovar,pathovar,mlst,sequencing_status,isolation_source,isolation_site,isolation_comments,collecton_date,isolation_country,latitude,longitude,host_name,host_gender,host_age,host_health,body_sample_site,body_sample_subsite,disease)&limit(10,0)", function(data){ assert.strictEqual(data.length,10) }]
	]

	queries.forEach(function(bq){
		var model = bq[0];
		var query = bq[1];
		var handler=bq[2];
		console.log("query: ", query);
		suite["/"+model+"/"+ query] = function(){
			var dfd = this.async(20000);
			request('http://localhost:3002/' + model + '/' + query,{headers:{accept:"application/json"},handleAs:"json"}).then(dfd.callback(handler),dfd.reject.bind(dfd));
			return dfd;
		}
	});
//	console.log("Register Suite: ", suite);
	registerSuite(suite);	
});
