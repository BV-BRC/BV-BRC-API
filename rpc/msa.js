var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:msa');
var ChildProcess = require("child_process");
var config = require("../config");
var request = require('request');
var distributeURL = config.get("distributeURL");
var Temp = require('temp');
var fs = require('fs-extra');

function runQuery(query,opts){
	debug("Query: ", query)
	var def = new defer();

	debug("Send Request to distributeURL: ", distributeURL + "genome_feature");
	debug("runQuery: ", query);
	request.post({
		url: distributeURL + "genome_feature/",
		headers: {
			"content-type": "application/rqlquery+x-www-form-urlencoded",
			accept: "application/protein_mini+fasta"
		},
		body: query
	}, function(err,r,body){
		//debug("Distribute RESULTS: ", body);

		if (err){
			return def.reject(err);
		}

		def.resolve(body);
	});

	return def.promise;
}

function runMuscle(sequences,opts){
	var def = new defer();
	var d = [];
	var errorClosed;

	debug("Run Aligner");
	var child = ChildProcess.spawn("muscle",["-fasta", "-maxiters","2"],{
		stdio: [
			'pipe',
			'pipe', // pipe child's stdout to parent
      		'pipe'
      	]
    });

	child.stdout.on("data", function(data){
		debug("Muscle Output Data: ", data.toString());
		d.push(data.toString());
	})

	child.stderr.on("data", function(errData){
		debug("Muscle STDERR Data: ", errData.toString());
	})

	child.on("error", function(err){
		errorClosed = true;
		def.reject(err);
	})

	child.on('close', function(code){
		debug("Muscle Process closed.", code);
		if (!errorClosed) {
			def.resolve(d.join(""));
		}
	})

	child.stdin.write(sequences,"utf8");
	child.stdin.end();
	
	return def.promise;
}


function runGBlocks(input,opts){
	var def = new defer();
	var d = [];
	var errorClosed;
	var tempName = Temp.path({suffix: '.aga'});

	console.log("GBlocks Temp File Input: ", tempName)

	fs.outputFile(tempName,input,function(err){
		if (err) { def.reject(err); return; }

		debug("Run Gblocks");
		var child = ChildProcess.spawn("Gblocks",[tempName, "-b5=h"],{
			stdio: [
				'pipe',
				'pipe', // pipe child's stdout to parent
	      		'pipe'
	      	]
	    });

		child.stderr.on("data", function(errData){
			debug("GBlocks STDERR Data: ", errData.toString());
		})

		child.on("error", function(err){
			errorClosed = true;
			def.reject(err);
		})

		child.on('close', function(code){
			debug("GBlocks Process closed.", code);
			if (!errorClosed) {

				console.log("Read File: ", tempName + "-gb");
				fs.exists(tempName + "-gb", function(exists){
					if (!exists){
						def.reject("Gblocks Output Does Not Exist");
						return;
					}

					fs.readFile(tempName + "-gb", "utf8", function(err,data){
						var empty=true;
						if (err) {
							def.reject("Unable to Read Gblocks output: ", err);
							return;
						}


						var locusList=[];
						// console.log("data: ", data);

						var lines = data.split("\n");
						lines.forEach(function(line){
							line=line.trim();
							console.log("Line: ", line)
		
							if (!line || line.length==0) { return; };
							if (line == ">undefined") { return; };

							if (line.charAt(0)==">"){
								locusList.push(line.substr(1))
							}else{
								empty = false;
							}
						})

						fs.readFile(tempName,"utf8", function(err,rawData){
							def.resolve(rawData);
						});

						// console.log("locusList: ", locusList);
						// def.resolve(locusList.join("\n"));
					});
				})
			}
//			fs.unlink(tempName);
		})
	});

	return def.promise;
}

function runFastTree(input,opts){
	var def = new defer();
	var d = [];
	var errorClosed;

	debug("Run FastTre_LG");

	var tempName = Temp.path({suffix: '.aga-gb'});

	console.log("GBlocks Temp File Input: ", tempName)

	fs.outputFile(tempName,input,function(err){
		var child = ChildProcess.spawn("FastTree_LG",["-gamma","-nosupport",tempName],{
			stdio: [
				'pipe',
				'pipe', // pipe child's stdout to parent
	      		'pipe'
	      	]
	    });

		child.stdout.on("data", function(data){
			debug("FastTree_LG Output Data: ", data.toString());
			d.push(data.toString());
		})

		child.stderr.on("data", function(errData){
			debug("FastTree_LG STDERR Data: ", errData.toString());
		})

		child.on("error", function(err){
			errorClosed = true;
			def.reject(err);
		})

		child.on('close', function(code){
			debug("FastTree_LG Process closed.", code);
			if (!errorClosed) {
				def.resolve(d.join(""));
			}
		})

	});

	return def.promise;
}


module.exports = {
	requireAuthentication: false,
	validate: function(params,req,res){
		//validate parameters here 
		return true;
	},
	execute: function(params,req,res){
		var def = new defer()
		console.log("Execute MSA: ", params)
		var query = params[0];
		var opts = {req: req, user: req.user}


		when(runQuery(query,opts), function(sequences){
			when(runMuscle(sequences,opts), function(alignment){
				when(runGBlocks(alignment,opts), function(gblocksOut){
					when(runFastTree(gblocksOut,opts),function(results){
						def.resolve("The Result")
					}, function(err){
						def.reject("Unable to Complete FastTree: " + err);
					});
				}, function(err){
					def.reject("Unable to Complete GBLocks for Alignment: " + err);
				})
			}, function(err){
				def.reject("Unable to Complete Alignement: " + err);
			})
		}, function(err){
			def.reject("Unable To Retreive Feature Data for MSA: " + err);
		})
		return def.promise;
	}
}