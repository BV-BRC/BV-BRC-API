var express = require('express');
var router = express.Router({
	strict: true,
	mergeParams: true
});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var SolrQueryParser = require("../middleware/SolrQueryParser");
var RQLQueryParser = require("../middleware/RQLQueryParser");
var authMiddleware = require("../middleware/auth");
var solrjs = require("solrjs");
var media = require("../middleware/media");
var httpParams = require("../middleware/http-params");
var SOLR_URL = config.get("solr").url;
var bodyParser = require("body-parser");
var rql = require("solrjs/rql");
var Queue = require("file-queue").Queue;
var debug = require('debug')('p3api-server:indexer');
var formidable = require("formidable");
var uuid = require("uuid");
var fs = require("fs-extra");
var Path = require("path");

debug("Queue Directory: ", config.get("queueDirectory"));
var qdir = config.get("queueDirectory");
var queue;
fs.mkdirs(Path.join(qdir,"file_data"), function(err){
	if (err){
		console.log("Error Creating Index Directory Structure: ", err);
		return;
	}
	fs.mkdirs(Path.join(qdir,"history"), function(err){
		if (err) {
			console.log("Error Creating Index History Directory: ", err);
			return;
		}
		fs.mkdirs(Path.join(qdir,"errors"), function(err){	
			if (err) {
				console.log("Error Creating Index Error Directory: ", err);
				return;
			}
	
			queue = new Queue(qdir, function(err) {
				if (err) {
					debug("error: ", err);
					return;
				}
				debug("Created Queue.");
			});
		});

	});

});


router.use(httpParams);
router.use(authMiddleware);

router.use(function(req, res, next) {
	debug("req.path", req.path);
	debug("req content-type", req.get("content-type"));
	debug("accept", req.get("accept"));
	debug("req.url", req.url);
	debug('req.path', req.path);
	debug('req.params:', JSON.stringify(req.params));
	next();
});

router.get("/:id", function(req,res,next){
	fs.readJson(Path.join(qdir,"history",req.params.id), function(err,data){
		if (err) {
			return next(err);
		}
		res.set("content-type", "application/json");
		res.send(JSON.stringify(data));
		res.end();
	});
});

router.post("/:type", [
	function(req, res, next) {
		if (!req.user) {
			res.sendStatus(401);
			return;
		}

		if (!req.params || !req.params.type || (!req.params.type=="genome")){
			res.sendStatus(406);	
			return;
		}

		if (!queue){
			res.send("Indexing is unavailable due to a queueing error");
			res.end(500);
			return;
		}
		var form = new formidable.IncomingForm();
		var qid=uuid.v4();
		fs.mkdirs(Path.join(qdir,"file_data",qid), function(err) {
			if (err) {
				console.log("Error creating output directory for index files to be queued: ", Path.join(qdir,"file_data", qid));
				res.end(500);
				return;
			}
			form.keepExtensions=true;
			form.uploadDir=Path.join(qdir,"file_data",qid);
			form.multiples=true;
			console.log("Begin parse");	
			form.parse(req, function(err, fields, files){
				var d = {id: qid,type: req.params.type,user: req.user, options: fields, files: {}};

				Object.keys(files).forEach(function(type){
					d.files[type] = files[type]
				});

				

				queue.push(d, function(err){
					if (err){
						res.error("Error Adding to queue: " + err);
						res.end(500);
						return;
					}
					d.state = "queued";
					d.queueTime = new Date();

					fs.writeJson(Path.join(qdir,"history",qid), d, function(err){
						res.set("content-type","application/json");
						res.send(JSON.stringify({id: qid, state: queued, queueTime: d.queueTime}));
						res.end();
					});
				});

				
			});
		});

	}
]);

module.exports = router;
