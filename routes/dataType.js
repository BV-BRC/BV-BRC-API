var express = require('express');
var router = express.Router({strict: true, mergeParams: true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var SolrQueryParser = require("../middleware/SolrQueryParser");
var RQLQueryParser = require("../middleware/RQLQueryParser");
var DecorateQuery = require("../middleware/DecorateQuery");
var ExtractCustomFields = require("../middleware/ExtractCustomFields");
var PublicDataTypes = require("../middleware/PublicDataTypes");
var authMiddleware = require("../middleware/auth");
var streamingHandler = require("../middleware/stream");
var Limiter = require("../middleware/Limiter");
var ContentRange = require("../middleware/content-range");
var APIMethodHandler = require("../middleware/APIMethodHandler");
var cacheMiddleware = require("../middleware/cache");
var patchMiddleware = require("../middleware/patch");
var httpParams = require("../middleware/http-params");
var solrjs = require("solrjs");
var media = require("../middleware/media");
var SOLR_URL = config.get("solr").url;
var bodyParser = require("body-parser");
var rql = require("solrjs/rql");
var debug = require('debug')('p3api-server:route/dataType');
var Expander = require("../ExpandingQuery");
var querystring = require('querystring');

router.use(httpParams);

router.use(authMiddleware);

router.use(PublicDataTypes);

// router.use(function(req,res,next){
// 	debug("req.path", req.path);
// 	debug("req content-type", req.get("content-type"));
// 	debug("accept", req.get("accept"));
// 	debug("req.url", req.url);
// 	debug('req.path', req.path);
// 	debug('req.params:', JSON.stringify(req.params));
// 	next();
// });

router.use(function(req, res, next){
	req.isDownload = !!(req.headers && req.headers.download);

	debug("REQ IS DOWNLOAD: ", req.isDownload);
	next();
});

router.get("*", function(req, res, next){
	if(req.path == "/"){
		req.call_method = "query";
		var ctype = req.get('content-type');

		debug("ctype: ", ctype);

		if(!ctype){
			ctype = req.headers['content-type'] = "application/x-www-form-urlencoded"
		}

		if(ctype == "application/solrquery+x-www-form-urlencoded"){
			req.queryType = "solr";
		}else{
			req.queryType = "rql";
		}
		debug('req.queryType: ', req.queryType)
		debug("req.headers: ", req.headers);

		req.call_params = [req._parsedUrl.query || ""];
		req.call_collection = req.params.dataType;
	}else if(req.path == '/schema'){
		req.call_method = "schema";
		req.call_params = [];
		req.call_collection = req.params.dataType;
    }else{
		if(req.params[0]){
			req.params[0] = req.params[0].substr(1);
			var ids = decodeURIComponent(req.params[0]).split(",");
			if(ids.length == 1){
				ids = ids[0]
			}
		}
		req.call_method = "get";
		req.call_params = [ids];
		req.call_collection = req.params.dataType;
	}

	next();
})


// patch/update objects
router.patch("/:target_id", [
	bodyParser.json({type: ["application/jsonpatch+json"], limit: "100mb"}),
	patchMiddleware
])	


//same thing as patch, but done over a post for clients that cannot issue the patch http verb
router.post("/:target_id", [
	bodyParser.json({type: ["application/jsonpatch+json"], limit: "100mb"}),
	patchMiddleware
])	



router.post("*", [
	bodyParser.json({type: ["application/jsonrpc+json"], limit: "30mb"}),
	bodyParser.json({type: ["application/json"], limit: "30mb"}),
	function(req, res, next){
		debug("json req._body", req._body);
		if(!req._body || !req.body){
			next();
			return
		}
		var ctype = req.get("content-type");
		if(req.body.jsonrpc || (ctype == "application/jsonrpc+json")){
			debug("JSON RPC Request", JSON.stringify(req.body, null, 4));
			if(!req.body.method){
				throw Error("Invalid Method");
			}
			req.call_method = req.body.method;
			req.call_params = req.body.params;
			req.call_collection = req.params.dataType;
		}else{
//			debug("JSON POST Request", JSON.stringify(req.body,null,4));
			req.call_method = "post";
			req.call_params = [req.body];
			req.call_collection = req.params.dataType;
		}
		next("route");
	},

	bodyParser.text({type: "application/x-www-form-urlencoded", limit: "30mb"}),
	function(req, res, next){
		debug("x-www-form-url-encoded check", body);
		req.call_method = "query";
		req.call_collection = req.params.dataType;
		var body = querystring.parse(req.body);
		debug("BODY: ", body);
		if(body.rql){
			req.call_params = [decodeURIComponent(body.rql)]
			req.queryType = "rql";
		}else if(body.solr){
			req.call_params = [decodeURIComponent(body.solr)];
			req.queryType = "solr";
		}else{
			return next();
		}
		debug("CALL_PARAMS: ", req.call_params);
		next("route");
	},

	bodyParser.text({type: "application/rqlquery+x-www-form-urlencoded", limit: "30mb"}),
	bodyParser.text({type: "application/solrquery+x-www-form-urlencoded", limit: "30mb"}),
	function(req, res, next){
		debug("Handle Form Body")
//		req.body=decodeURIComponent(req.body);
//		if (!req._body || !req.body) { debug(" No body to QUERY POST"); req.body="?keyword(*)"; } // next("route"); return }
		var ctype = req.get("content-type");
		req.call_method = "query";
		req.call_params = req.body ? [req.body] : [];
		req.call_collection = req.params.dataType;
		req.queryType = (ctype == "application/solrquery+x-www-form-urlencoded") ? "solr" : "rql";

		next();
	}
])

router.use([
	RQLQueryParser,
	DecorateQuery,
	Limiter,
	function(req, res, next){
		if(!req.call_method || !req.call_collection){
			return next("route");
		}
		debug("req.call_method: ", req.call_method);
		debug('req.call_collection: ', req.call_collection);

		if(req.call_method == "query"){
			debug('req.queryType: ', req.queryType);
		}
		next();
	},
	streamingHandler.checkIfStreaming,
	[cacheMiddleware.get, APIMethodHandler, cacheMiddleware.put],
	ExtractCustomFields,
	ContentRange,
	media
])

module.exports = router;
