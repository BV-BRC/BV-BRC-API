var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:panaconda');
var ChildProcess = require("child_process");
var config = require("../config");
var request = require('request');
var distributeURL = config.get("distributeURL");

function runQuery(query,opts){
	debug("Query: ", query)
	var def = new defer();

	debug("Send Request to distributeURL: ", distributeURL + "genome_feature");
	debug("runQuery: ", query);
	request.post({
		url: distributeURL + "genome_feature/",
		headers: {
			"content-type": "application/rqlquery+x-www-form-urlencoded",
			"accept": "text/tsv",
            "Authorization": opts.token || "",
            // "download": true
		},
		body: query
	}, function(err,r,body){
		//debug("Distribute RESULTS: ", body);

		if (err){
			return def.reject(err);
		}

		//if (body && typeof body=="string"){
		//	body = JSON.parse(body)
		//}
		def.resolve(body);
	});

	return def.promise;
}


function buildGraph(annotations,opts){
	var def = new defer();
	var d = [];
	var errorClosed;

	debug("Run Panaconda");
	var child = ChildProcess.spawn("python", ["/disks/patric-common/runtime/bin/fam_to_graph.py",
            "--"+opts.alpha, "--layout", "--ksize",opts.ksize,"--diversity",opts.diversity,"--context",opts.context],{
		stdio: [
			'pipe',
			'pipe', // pipe child's stdout to parent
      		'pipe'
      	]
    });

	child.stdout.on("data", function(data){
		debug("Panaconda done");
		d.push(data.toString());
	})

	child.stderr.on("data", function(errData){
		debug("Panaconda STDERR Data: ", errData.toString());
	})

	child.on("error", function(err){
		errorClosed = true;
		def.reject(err);
	})

	child.on('close', function(code){
		debug("Panaconda Process closed.", code);
		if (!errorClosed) {
			def.resolve(d.join(""));
		}
	})

	child.stdin.write(annotations,"utf8");
	child.stdin.end();
	
	return def.promise;
}


module.exports = {
	requireAuthentication: false,
	validate: function(params,req,res){
		//validate parameters here 
		return params && params[0] && params[1] && params[0].length>1 && params[1].length>1;
	},
	execute: function(params,req,res){
		var def = new defer()
		// console.log("Execute MSA: ", params)
		var query = params[0];
        var alpha = params[1];
        var ksize = params[2];
        var context = params[3];
        var diversity = params[4];
		var opts = {req: req, user: req.user, token:req.headers.authorization, alpha:alpha, ksize:ksize, context:context, diversity:diversity}


		when(runQuery(query,opts), function(annotations){
			when(buildGraph(annotations,opts), function(graph){
                    def.resolve({
                        graph: graph
                    })
			}, function(err){
			def.reject("Failure to build pg-graph: " + err);
		    })
		}, function(err){
			def.reject("Unable To retreive annotations for pg-graph: " + err);
		});
		return def.promise;
	}
}
