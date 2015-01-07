var debug = require('debug')('p3api-server:media');
module.exports=function(req,res,next){
	var rpcTypes = ["application/jsonrpc.result+json", "application/jsonrpc+json"];

	if (rpcTypes.some(function(t){
		return req.is(t);
	})){
		debug("RPC Request");
	}

	res.format({
		"text/plain": function(){
			debug("text/plain handler")
			res.send(JSON.stringify(res.results,null,4));
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