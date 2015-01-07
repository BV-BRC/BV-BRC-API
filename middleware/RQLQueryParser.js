var express = require('express');
var router = express.Router();
var rql = require("solrjs/rql");

module.exports = function(req, res, next) {
	console.log("RQLQueryParser", req._parsedUrl);
	req.rql_query = req._parsedUrl.query || "";
	
	req.solr_query = rql(req.rql_query).toSolr() 
	console.log("Converted Solr Query: ", req.solr_query);
	next();
}