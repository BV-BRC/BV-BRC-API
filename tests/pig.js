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
		["pig", "?descendants((1386))", function(data){ assert.strictEqual(data.length,10) }],
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
