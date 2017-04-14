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


// handle GET hpiSearch/
// Not sure what to return here
router.get("/", [
	bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
		res.write("--- acknowledged GET for hpiSearch \n");
    res.end();
	}
])

// handle POST hpiSearch/
// Given an input set of Host IDs and match parameters, return matching experiments and ID lists
// curl -H "Content-Type: application/json" -X POST "http://localhost:3001/hpiSearch" -d @tmp.json
router.post("/", [
	bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged POST for hpiSearch \n");
    res.end();
	}
])

// GET hpiSearch/experiment
// Maybe a 404 or a list of all experiment ids
router.get("/experiment", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged GET for hpiSearch/experiemnt \n");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}
router.get("/experiment/:id", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    ddebug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier} \n");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}
router.get("/experiment/:id/idList/:id_list", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier} \n");
    res.end();
	}
]);

//XXX this one is busted
// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs="human">
router.get("/experiment/:id/idList/:id_list/ids<>", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs=\"human\"> \n");
    res.end();
	}
]);

// GET hpiSearch/api
router.get("/api", [
	function(req, res, next){
		// next(); // for passing control to the next middleware function
    debug("req.body: ", req.body);
    debug("CALL_PARAMS: ", req.call_params);
    res.write("--- acknowledged GET for hpiSearch/api \n");
    res.end();
	}
]);





module.exports = router;
