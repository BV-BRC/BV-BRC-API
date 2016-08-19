var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var httpParams = require("../middleware/http-params");
var media = require("../middleware/media");
var debug = require('debug')('p3api-server:contentRoute');
var fs = require('fs-extra');
var Path = require('path');

router.use(httpParams);

var contentFolder = config.get("contentDirectory");

router.get("*", function(req,res,next){
	console.log("PARAMS : ", req.params[0]);
	var f = Path.join(contentFolder,req.params[0])
	fs.exists(f, function(exists){
		if (!exists) { return next("route"); }

		fs.createReadStream(f).pipe(res);
	})
})
    
module.exports = router;
