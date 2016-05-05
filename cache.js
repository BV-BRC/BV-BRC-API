var debug = require('debug')('p3api-server:cachemiddleware');
var fs = require('fs-extra');
var conf = require("./config");
var Path = require("path");
var defer = require("promised-io/promise").defer;
var touch = require("touch");

var cacheDir = conf.get("cache").directory;
debug("Using Cache Dir: ", cacheDir);

module.exports = {
	get: function(key,options){
		var def = new defer();
		options = options || {};
	
		if (!options.user){
			options.user='public'
		}	


		var fn = Path.join(cacheDir,options.user,key);
		console.log("Check for Cached Data in: ", fn);
		fs.exists(fn, function(exists){
			if (!exists){
				def.reject(false);
				return;
			}

			fs.readJson(fn, function(err,data){
				if (err) {
					return def.reject(err);
				}

				def.resolve(data);

				touch(fn);
			});

		});

		return def.promise;
	},

	put: function(key,data,options){
		options = options || {};
	
		if (!options.user){
			options.user='public'
		}	

		var def = new defer();
		var fn = Path.join(cacheDir,options.user,key);
		console.log("Store Cached Data to: ", fn);
		fs.outputJson(fn,data, function(err){
			if (err){
				def.reject(err);
				return;
			}

			def.resolve(true);
		});

		return def.promise;
	}
}
