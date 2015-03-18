var debug = require('debug')('p3api-server:media');
module.exports=function(req,res,next){
	var rpcTypes = ["application/jsonrpc.result+json", "application/jsonrpc+json"];

	if (rpcTypes.some(function(t){
		return req.is(t);
	})){
		debug("RPC Request");
	}

	res.format({
		"text/csv": function(){
			debug("text/csv handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric3_query.csv");
			}
			console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				var fields = Object.keys(res.results.response.docs[0]);
				res.write(fields.join(",") + "\n");
				console.log("Fields: ", fields);
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return o[field];	
					});
					console.log("row: ", row);
					res.write(row.join(",") + "\n");
				});	
			}

			res.end();
		},
		"text/tsv": function(){
			debug("text/tsv handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric3_query.txt");
			}
			console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				var fields = Object.keys(res.results.response.docs[0]);
				res.write(fields.join("\t") + "\n");
				console.log("Fields: ", fields);
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return o[field];	
					});
					console.log("row: ", row);
					res.write(row.join("\t") + "\n");
				});	
			}

			res.end();
	
		},
		"application/solr+json": function(){
			debug("application/json handler")	
			res.send(JSON.stringify(res.results));
			res.end();
		},

		"application/json": function(){
			debug("application/json handler")	
			if (req.call_method=="query"){
				if (res.results && res.results.response && res.results.response.docs){
					res.send(JSON.stringify(res.results.response.docs));
				}else{
					res.status(404);
				}
			} else{
					if (!res.results){
						res.status(404)
					}else{
						res.send(JSON.stringify(res.results));
					}
			}
			res.end();
		}
	})
}
