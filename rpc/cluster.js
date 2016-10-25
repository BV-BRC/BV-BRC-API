var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:cluster');
var ChildProcess = require('child_process');
var config = require("../config");
var request = require('request');
var distributeURL = config.get("distributeURL");
var Temp = require('temp');
var fs = require('fs-extra');

function runCluster(data, config, opts){
	var def = new defer();
	var errorClosed;

	debug("Run Cluster");

	var tempFileInput = Temp.path({prefix: 'cluster.', suffix: '.input'});
	var tempFileBase = tempFileInput.replace(".input", "");
	var tempFileOutput = tempFileBase + '.cdt';
	var tempFilePath = tempFileBase.split("cluster.")[0];

	debug("Cluster Temp File Input: ", tempFileInput, 'at', tempFilePath);

	fs.outputFile(tempFileInput, data, function(err){
		if(err){
			def.reject("Unable to write input data to", tempFileInput);
			return;
		}

		var child = ChildProcess.spawn("cluster",
			["-f", tempFileInput, "-u", tempFileBase,
				"-g", config.g || 1, "-e", config.e || 2, "-m", config.m || 'a'],
			{
				cwd: tempFilePath,
				stdio: [
					'pipe',
					'pipe',
					'pipe'
				]
			});

		setTimeout(function(){
			debug("Cluster timed out!");
			def.reject('Timed out. Cluster took more than 20 mins. Please reduce the data set and try again.');
			child.kill('SIGHUP');
		}, 1000 * 60 * 20);

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
				fs.readFile(tempFileOutput, "utf8", function(err, data){

					if(err){
						def.reject("Unable to read " + tempFileOutput);
						return;
					}

					var output = {};
					var rows = [];
					var count = 0;
					var lines = data.split('\n');

					lines.forEach(function(line){
						line = line.trim();
						if(!line || line.length == 0) return;

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

			// remove all related files
			fs.remove(tempFileBase + '.*', function(err){
				if(err) return debug(err);

				debug('success removed temp files: ', tempFileBase + ".*");
			});
		});
	});

	return def.promise;
}

module.exports = {
	requireAuthentication: false,
	validate: function(params, req, res){
		//validate parameters here
		return params && params[0];
	},
	execute: function(params, req, res){
		var def = new defer();

		var data = params[0];
		var config = params[1];
		var opts = {req: req, user: req.user};

		when(runCluster(data, config, opts), function(result){

			def.resolve(result);

		}, function(err){
			def.reject("Unable to Complete Cluster: " + err);
		});

		return def.promise;
	}
};