/*

Host-Pathogen Interaction (HPI) Search APIs

Use-Case: Given a defined list of host genes/pathways/GO terms/etc, find the
experiments (transcriptional regulation studies / genetic or small molecule
screens / population-level evolutionary analysis /etc) supported by other BRCs
might be of interest (i.e. yield a similar set of results)


GET
curl 'http://localhost:3001/hpiSearch/'

POST
curl 'http://localhost:3001/hpiSearch/' --data-binary 'eq(type,test)' --compressed

*/


// import dependencies
var express = require('express');
var router = express.Router({strict: true, mergeParams: true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var bodyParser = require("body-parser");
var debug = require('debug')('p3api-server:route/hpiSearchRouter');
var httpParams = require("../middleware/http-params"); // checks for stuff starting with http_ in the query and sets it as a header
var authMiddleware = require("../middleware/auth");
var querystring = require("querystring");

router.use(httpParams);
router.use(authMiddleware);


// handle POST hpiSearch/
router.post("/", [
	bodyParser.urlencoded({extended: true}),
	function(req, res, next){
		debug("req.body: ", req.body);
    res.write("--- acknowledged POST for hpiSearch");
    res.end();
	}
])

// GET hpiSearch/experiment
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    res.write("--- acknowledged GET for hpiSearch/experiemnt");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier}");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs="human">
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs=\"human\">");
    res.end();
	}
]);

// GET hpiSearch/api
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    res.write("--- acknowledged GET for hpiSearch/api");
    res.end();
	}
]);





module.exports = router;
