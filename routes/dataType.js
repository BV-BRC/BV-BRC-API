var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var SolrQueryParser = require("../middleware/SolrQueryParser");
var RQLQueryParser = require("../middleware/RQLQueryParser");
var authMiddleware = require("../middleware/auth");
var solrjs = require("solrjs");
var media = require("../middleware/media");
var httpParams = require("../middleware/http-params");
var SOLR_URL=config.get("solr").url;
var bodyParser = require("body-parser");
var rql = require("solrjs/rql");
var debug = require('debug')('p3api-server:dataroute');
var Expander= require("../ExpandingQuery");



var publicFree=['enzyme_class_ref', 'gene_ontology_ref', 'id_ref', 'misc_niaid_sgc', 'pathway_ref', 'ppi', 'protein_family_ref', 'sp_gene_evidence', 'sp_gene_ref', 'taxonomy', 'transcriptomics_experiment', 'transcriptomics_gene', 'transcriptomics_sample',"model_reaction","model_complex_role","model_compound","model_template_biomass","model_template_reaction"];

var rqlToSolr = function(req, res, next) {
	debug("RQLQueryParser", req.queryType);
	if (req.queryType=="rql"){
		req.call_params[0] = req.call_params[0] || "";
		when(Expander.ResolveQuery(req.call_params[0],{req:req,res:res}), function(q){
			debug("Resolved Query: ", q);
			if (q=="()") { q = ""; }
			req.call_params[0] = rql(q).toSolr({maxRequestLimit: 25000, defaultLimit: 25}) 
			debug("Converted Solr Query: ", req.call_params[0]);
			req.queryType="solr";
			next();
		});
	}else{
		next();
	}
}

var querySOLR = function(req, res, next) {
		if (req.call_method!="query"){ next(); }

		var query = req.call_params[0];
		debug("querySOLR() req.params", req.call_params);
		var solr = new solrjs(SOLR_URL + "/" + req.call_collection);

		when(solr.query(query), function(results) {
			if (!results || !results.response){
				res.results=[];
				res.set("Content-Range", "items 0-0/0");
			}else{
				res.results = results;

				res.set("Content-Range", "items " + (results.response.start || 0) + "-" + ((results.response.start||0)+results.response.docs.length) + "/" + results.response.numFound);
			}
//			debug("res headers: ", res);
			next();
		}, function(err){
			debug("Error Querying SOLR: ", err);
			next(err);
		})
}
var getSOLR = function(req, res, next) {
	var solr = new solrjs(SOLR_URL + "/" + req.call_collection);
	when(solr.get(req.call_params[0]), function(sresults) {
		if (sresults) {
			var results = sresults.doc;
//			console.log("results: ", results);
			console.log("results.public: ", results.public);
			console.log("publicFree: ", (publicFree.indexOf(req._call_collection)>=0) );
			console.log("Owner: ", results.owner, req.user);
			console.log("user_read: ", results.user_read, (results.user_read && results.user_read.indexOf(req.user)>=0));

			if (results.public || (publicFree.indexOf(req._call_collection)>=0) || (results.owner==(req.user)) || (results.user_read && results.user_read.indexOf(req.user)>=0)) {		
				res.results = sresults;
				console.log("Results: ", results);
				next();
			}else{
				if (!req.user){
					console.log("User not logged in, permission denied");
					res.sendStatus(401);
				}else{
					console.log("User forbidden from private data");
					res.sendStatus(403);
				}
			}
		}else{
			next();
		} 
	});
}

var decorateQuery = function(req, res, next) {
	if (req.call_method !="query"){ return next(); }

	debug("decorateQuery", req.solr_query);
	req.call_params[0] = req.call_params[0] || "&q=*:*";
	if (!req.user) {
		if (publicFree.indexOf(req.call_collection)<0) {
			req.call_params[0] = req.call_params[0] + "&fq=public:true"
		}
	}
	else {
		if (publicFree.indexOf(req.call_collection)<0) {
			req.call_params[0]= req.call_params[0] + ("&fq=(public:true OR owner:" + req.user +" OR user_read:" + req.user +")");
		}
	}

	next();
}

var methodHandler  = function(req, res, next) {
	debug("MethodHandler", req.call_method, req.call_params);
	switch(req.call_method) {
		case "query": 
			return querySOLR(req,res,next);
			break;
		case "get":
			return getSOLR(req,res,next)
			break;
	}
}

router.use(httpParams);

router.use(authMiddleware);

router.use(function(req,res,next){
	debug("req.path", req.path);
	debug("req content-type", req.get("content-type"));
	debug("accept", req.get("accept"));
	debug("req.url", req.url);
	debug('req.path', req.path);
	debug('req.params:', JSON.stringify(req.params));
	next();
});


router.get("*", function(req,res,next){
	if (req.path=="/"){
		req.call_method = "query";
		var ctype = req.get('content-type');

		debug("ctype: ", ctype);

		if (!ctype){ ctype = req.headers['content-type'] = "applicaton/x-www-form-urlencoded"}

		if (ctype == "application/solrquery+x-www-form-urlencoded"){
			req.queryType = "solr";
		}else{
			req.queryType = "rql";
		}
		debug('req.queryType: ', req.queryType)
		debug("req.headers: ", req.headers);
		if (req.headers && req.headers.download){
			req.isDownload = true;
		}
		debug("req.isDownload: ", req.isDownload);
		req.call_params = [req._parsedUrl.query||""];
		req.call_collection = req.params.dataType;
	}else{
		if (req.params[0]){
			req.params[0] = req.params[0].substr(1);
			var ids = decodeURIComponent(req.params[0]).split(",");
			if (ids.length == 1) { ids=ids[0]}
		}
		req.call_method = "get";
		req.call_params = [ids];
		req.call_collection = req.params.dataType;
	}

	next();
})


router.post("*", [
	bodyParser.json({type:["application/jsonrpc+json"]}),
	bodyParser.json({type:["application/json"]}),
	function(req,res,next){
		debug("json req._body", req._body);
		if (!req._body || !req.body) { next(); return }
		var ctype=req.get("content-type");
		if (req.body.jsonrpc || (ctype=="application/jsonrpc+json")){
			debug("JSON RPC Request", JSON.stringify(req.body,null,4));	
			if (!req.body.method){
				throw Error("Invalid Method");
			}
			req.call_method=req.body.method;
			req.call_params = req.body.params;
			req.call_collection = req.params.dataType;
		}else{
//			debug("JSON POST Request", JSON.stringify(req.body,null,4));
			req.call_method="post";
			req.call_params = [req.body];
			req.call_collection = req.params.dataType;
		}
		next("route");
	},
	bodyParser.text({type:"application/rqlquery+x-www-form-urlencoded",limit:10000000}),
	bodyParser.text({type:"application/solrquery+x-www-form-urlencoded",limit: 10000000}),
	function(req,res,next){
//		req.body=decodeURIComponent(req.body);
		debug("SOLR QUERY POST : ", req.body,req._body);
		if (!req._body || !req.body) { next("route"); return }
		var ctype=req.get("content-type");	
		req.call_method="query";
		req.call_params = [req.body];
		req.call_collection = req.params.dataType;
		req.queryType = (ctype=="application/solrquery+x-www-form-urlencoded")?"solr":"rql";
		next();
	}
])

var maxLimit=25000;
var defaultLimit=25;

router.use([
	rqlToSolr,
	decorateQuery,
	function(req,res,next){
		if (req.call_method!="query") { return next(); }
		var limit = maxLimit;
		var q = req.call_params[0];
		var re = /(&rows=)(\d*)/;
		var matches = q.match(re);

		if (!matches){
			limit = defaultLimit
		}else  if (matches && typeof matches[2]!='undefined' && (matches[2]>maxLimit) && (!req.isDownload)){
			limit=maxLimit
		}else{
			limit=matches[2];
		}
		//console.log("limit matches: ", matches, " limit: ", limit);
		//console.log("req.headers.range: ", req.headers.range);
		if (req.headers.range) {
			var range = req.headers.range.match(/^items=(\d+)-(\d+)?$/);
			//console.log("Range: ", range);
			if (range){
				start = range[1] || 0;
				end = range[2] || maxLimit;
				var l = end - start;
				if (l>maxLimit){
					limit=maxLimit;
				}else{
					limit=l;
				}

				var queryOffset=start;
			}
		}


		if (matches){
			req.call_params[0]= q.replace(matches[0],"&rows="+limit);
		}else{
			req.call_params[0] = req.call_params[0] + "&rows=" + limit;
		}

		if (queryOffset) {
			re = /(&start=)(\d+)/;
			var offsetMatches = q.match(re);
			if (!offsetMatches){
				req.call_params[0] = req.call_params[0] + "&start=" + queryOffset;
			}
		}
		//console.log("query: ", req.call_params[0]);
		next();
	},
	function(req,res,next){
		if (!req.call_method || !req.call_collection) { return next("route"); }
		debug("req.call_method: ", req.call_method);
		debug('req.call_params: ', req.call_params);
		debug('req.call_collection: ', req.call_collection);

		if (req.call_method=="query"){
			debug('req.queryType: ', req.queryType);
		}
		next();
	},
	methodHandler,
	media
])

module.exports = router;
