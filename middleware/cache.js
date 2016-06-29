var debug = require('debug')('p3api-server:cachemiddleware');
var Cache = require("../cache");
var conf = require("../config");
var md5 = require("md5");
var when = require("promised-io/promise").when;
var enableCache = conf.get("cache").enable;

module.exports.get = function(req, res, next) {
	if (!enableCache) { return next(); }

	var key=[req.call_method,req.call_collection,req.queryType,req.call_params[0]];
	if (req.call_method=="stream"){ return next(); }

	req.cacheKey = md5(key.join());
	debug("Cache Req User: ", req.user);

	debug("Cache Key: ", req.cacheKey, key);
	var opts={}
	if (req.user){
		opts.user = req.user.id || req.user;	
	}	

	res.queryStart = new Date()
	when(Cache.get(req.cacheKey,opts), function(data){
		req.cacheHit=true;
		res.results = data;
		debug("CACHE HIT: ", req.cacheKey);
		next();
	}, function(err){
		if (err) { 
			debug("CACHE MISSED ERROR: ", err); 
		}else{
			debug("CACHE MISS");
		}
		next();
	});
}


module.exports.put= function(req, res, next) {
	if (!req.cacheHit && req.cacheKey){
		var opts = {};
	        if (req.user){
			opts.user = req.user.id || req.user;
		}
		debug("Store Cached Data: ", req.cacheKey);	
		Cache.put(req.cacheKey,res.results,opts)
	}

	next();
}	
