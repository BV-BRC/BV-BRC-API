var bodyParser = require("body-parser");
var rpcMethods = require("../rpc");
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:rpcHandler');

module.exports = [
	bodyParser.json({type: ["application/jsonrpc+json"], limit: "30mb"}),
	bodyParser.json({type: ["application/json"], limit: "30mb"}),
	function(req, res, next){
		// debug("RPC HANDLER: ", req.body);
		if(!req.body){
			next();
			return
		}
		var ctype = req.get("content-type");
		// debug("CTYPE: ", ctype);

		if(req.body.jsonrpc || (ctype == "application/jsonrpc+json")){
			// debug("JSON RPC Request", JSON.stringify(req.body, null, 4));

			if(!req.body.method){
				throw Error("No Method Supplied");
			}

			var methodDef = rpcMethods[req.body.method];
			if(!methodDef){
				throw Error("Invalid Method: " + req.body.method);
			}

			if(methodDef.requireAuth && !req.user){
				res.status(401);
				throw Error("Authentication Required")
			}

			if(!methodDef.validate || !methodDef.validate(req.body.params, req, res)){
				throw Error("RPC Parameter Validation Failed: ", req.body.params);
			}

			req.call_method = req.body.method;
			req.call_params = req.body.params;
			next();
		}else{
			next("route");
		}
	},
	function(req, res, next){
		// debug("req.call_method: ", req.call_method);
		// debug("MethodDef: ", rpcMethods[req.call_method]);
		// debug('req.call_params: ', req.call_params);
		var methodDef = rpcMethods[req.call_method];

		res.results = methodDef.execute(req.call_params, req, res);
		when(res.results, function(r){
			// console.log("Got execute Results: ", r)
			res.results = r;
			next();
		}, function(err){
			console.log("Got Execute Error: ", err);
			res.error = err;
			next();
		});

	},

	function(req, res, next){
		//console.log("res.results: ", res.results)
		var out = {};
		out.id = req.body.id || 0;
		if(res.error){
			out.error = res.error.toString();
		}else{
			out.result = res.results;
		}
		//console.log("OUTPUT : ", out)
		res.write(JSON.stringify(out));
		res.end();
	}
];
