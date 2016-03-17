var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:cluster');
var ChildProcess = require('child_process');
var config = require("../config");
var request = require('request');
var distributeURL = config.get("distributeURL");
var Temp = require('temp');
var fs = require('fs-extra');

function uploadInputFile(params, opts){

}

function runCluster(input, opts){
	var def = new defer();
	//var d = [];
	var errorClosed;

	debug("Run Cluster");

	//Temp.track(); // automatically delete
	var tempPath = "/var/folders/tf/x6l7prmx6hjgrtzdp2l_r4980000gp/T/";
	var tempName = Temp.path({prefix: 'cluster.'});

	debug("Cluster Temp File Input: ", tempName);

	fs.outputFile(tempName, input, function(err){
		var child = ChildProcess.spawn("cluster",
			["-f", "cluster_input.txt", "-u", tempName, "-g", 1, "-e", 2, "-m", 'a'],
			{
				cwd: tempPath,
				stdio: [
					'pipe',
					'pipe',
					'pipe'
				]
		});

		//child.stdout.on("data", function(data){
		//	debug("Cluster Output Data: ", data.toString());
		//	d.push(data.toString());
		//});

		child.stderr.on("data", function(errData){
			debug("Cluster STDERR Data: ", errData.toString());
		});

		child.on("error", function(err){
			errorClosed = true;
			def.reject(err);
		});

		child.on('close', function(code){
			debug("Cluster Process closed.", code);

			if(!errorClosed){

				// read result file and return
				fs.readFile(tempName + '.cdt', "utf8", function(err, data){

					if (err){
						def.reject("Unable to read " + tempName + '.cdt');
						return;
					}

					var output = {};
					var rows = [];
					var count = 0;
					var lines = data.split('\n');

					lines.forEach(function(line){
						line = line.trim();
						if (!line || line.length == 0) return;

						var tabs = line.split('\t');
						if(count == 0){
							var columns = [];
							for(var i = 4; i < tabs.length; i++){
								columns.push(tabs[i].split('-')[0]);
							}
							output.columns = columns;
						}
						if(count >= 3){
							rows.push(tabs[1].split('-')[0]);
						}
						count++;
					});

					output.rows = rows;

					def.resolve(output);
				});
			}
		});
	});

	return def.promise;
}

module.exports = {
	requireAuthentication: false,
	validate: function(params, req, res){
		//validate parameters here
		return params && params[0] && params[0].input !== undefined;
	},
	execute: function(params, req, res){
		var def = new defer();
		debug("Execute Cluster: ", params);
		var query = params[0];
		var opts = {req: req, user: req.user};

		//when(uploadInputFile(params, opts), function(cluster){
			when(runCluster(query, opts), function(result){

				def.resolve(result);

			}, function(err){
				def.reject("Unable to Complete Cluster: " + err);
			});
		//});

		return def.promise;
	}
};