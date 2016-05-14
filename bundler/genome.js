var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:genomebundler');
var config = require("../config");
var request = require('request');
var distributeURL = config.get("distributeURL");
var publicGenomeDir = config.get("publicGenomeDir");
var Temp = require('temp');
var fs = require('fs-extra');
var Path = require("path");

var maxBundleSize = 500;

function runQuery(query,opts){
        debug("Query: ", query)
        var def = new defer();
        opts = opts||{}

        debug("Send Request to distributeURL: ", distributeURL + "genome_feature");
        debug("runQuery: ", query);
        request.post({
                url: distributeURL + "genome/",
                headers: {
                        "content-type": "application/rqlquery+x-www-form-urlencoded",
                        accept: "application/json",
                        authorization: opts.token || ""
                },
                body: query
        }, function(err,r,body){
                //debug("Distribute RESULTS: ", body);

                if (err){
                        return def.reject(err);
                }

                if (body && typeof body=="string"){
                        body = JSON.parse(body)
                }
                def.resolve(body);
        });

        return def.promise;
}


module.exports = function(req,res,next){
	console.log("GENOME BUNDLER");
	var q = req.query + "&limit(500)&select(genome_id,public,owner,genome_name)";
	console.log("q: ", q);

	when(runQuery(q,{token: req.headers.authorization||""}), function(genomes){
		console.log("DISTR Results: ", genomes)
		if (!genomes || genomes.length<0){
			return next("route");
		}
		var bulkMap = genomes.map(function(genome){
			var map={}
			if (genome.public){
				map.expand=true;
				map.cwd = Path.join(publicGenomeDir,genome.genome_id);
				map.dest = genome.genome_id;
				map.src = [];
				req.bundleTypes.forEach(function(bt){
					map.src.push(genome.genome_id + bt);
				})
			}else{
				return false
				console.log("Processing of private genomes not yet supported");
			}

			return map;
		}).filter(function(x){ return !!x });

		req.bulkMap = bulkMap;
		next();
	}, function(err){
		console.log("Error Retrieving Source Data for bundler: ", err);
		next(err);
	});
	
}
