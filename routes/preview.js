var express = require('express');
var router = express.Router({strict: true, mergeParams: true});
var config = require("../config");
var httpParams = require("../middleware/http-params");
var debug = require('debug')('p3api-server:route/preview');
var fs = require('fs-extra');
var Path = require('path');

router.use(httpParams);

var contentFolder = config.get("contentDirectory");

router.use(function(req, res, next){
	res.setHeader('content-type', 'text/html');
	res.write('<link type="text/css" rel="stylesheet" href="/api/js/p3.css">');
	res.write('<body class="patric" style="overflow:auto">');
	next();
});

router.get("*", function(req, res, next){
	debug("PARAMS : ", req.params[0]);
	var f = Path.join(contentFolder, req.params[0]);
	fs.exists(f, function(exists){
		if(!exists){
			return next("route");
		}

		fs.createReadStream(f).pipe(res);
	})
});

router.use(function(req, res, next){
	res.write('</body>');
	next();
});

module.exports = router;
