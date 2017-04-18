/*

Host-Pathogen Interaction (HPI) Search APIs

Use-Case: Given a defined list of host genes/pathways/GO terms/etc, find the
experiments (transcriptional regulation studies / genetic or small molecule
screens / population-level evolutionary analysis /etc) supported by other BRCs
might be of interest (i.e. yield a similar set of results)


GETs
curl 'http://localhost:3001/hpiSearch'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment/543'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment/543/idList'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment/543/idList/543,21'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment/543/idList/543,21/ids'
curl 'http://localhost:3001/hpiSearch/hpiSearch/experiment/543/idList/543,21/ids?includeOrthologs="human"'
curl 'http://localhost:3001/hpiSearch/api'

POST
curl -H "Content-Type: application/json" -X POST "http://localhost:3001/hpiSearch" -d '{ "type": "input string", "idSource": "id source input string", "ids": ["id 1", "id 2", "id 3"], "threshold": 0.5, "thresholdType": "a number", "additionalFlags": { "key1": "value1", "key2": "value2" } }'

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
		res.write("--- acknowledged GET for hpiSearch \n");
    res.end();
	}
])

// POST hpiSearch/
// Given an input set of Host IDs and match parameters, return matching experiments and ID lists
// curl -H "Content-Type: application/json" -X POST "http://localhost:3001/hpiSearch" -d '{ "type": "input string", "idSource": "id source input string", "ids": ["id 1", "id 2", "id 3"], "threshold": 0.5, "thresholdType": "a number", "additionalFlags": { "key1": "value1", "key2": "value2" } }'
router.post("/", [
	bodyParser.json(),
	function(req, res, next){
    debug("req.body: ", req.body);
    // req.body.type
    // req.body.idSource
    // req.body.ids
    // req.body.threshold
    // req.body.thresholdType
    // req.body.additionalFlags
    res.write("--- acknowledged POST for hpiSearch \n");
    res.end();
	}
])

// GET hpiSearch/experiment
// Maybe a 404 or a list of all experiment ids
router.get("/experiment", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    res.write("--- acknowledged GET for hpiSearch/experiemnt \n");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}
// The details of an experiment, as showin in the primary endpoint
router.get("/experiment/:id", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    debug("req.params: ", req.params);
    // req.params.id
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier} \n");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}
// The details of an experiment, as shown in the primary endpoint
router.get("/experiment/:id/idList/:id_list", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    debug("req.params: ", req.params);
    // req.params.id
    // req.params.id_list
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier} \n");
    res.end();
	}
]);

// GET hpiSearch/experiment/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs="human">
// Return the ids for the idList.  If the optional includeOrthologs parameter is supplied,
// return a second column with lorthologous ids from that organism
router.get("/experiment/:id/idList/:id_list/ids", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    debug("req.params: ", req.params);
    debug("req.query: ", req.query)
    // req.params.id
    // req.params.id_list
    // req.query.includeOrthologs
    res.write("--- acknowledged GET for hpiSearch/experiemnt/{experimentIdentifier}/idList/{listIdentifier}/ids \n");
    res.end();
	}
]);

// GET hpiSearch/api
// Supplies information specific to this BRC's implementation of the API
router.get("/api", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    res.write("--- acknowledged GET for hpiSearch/api \n");
    res.end();
	}
]);

module.exports = router;
