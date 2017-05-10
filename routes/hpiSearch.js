/*

Host-Pathogen Interaction (HPI) Search APIs

Use-Case: Given a defined list of host genes/pathways/GO terms/etc, find the
experiments (transcriptional regulation studies / genetic or small molecule
screens / population-level evolutionary analysis /etc) supported by other BRCs
might be of interest (i.e. yield a similar set of results)


GETs
curl 'http://localhost:3001/hpi/search'
curl 'http://localhost:3001/hpi/search/experiment'
curl 'http://localhost:3001/hpi/search/experiment/543'
curl 'http://localhost:3001/hpi/search/experiment/543/idList'
curl 'http://localhost:3001/hpi/search/experiment/543/idList/543,21'
curl 'http://localhost:3001/hpi/search/experiment/543/idList/543,21/ids'
curl 'http://localhost:3001/hpi/search/experiment/543/idList/543,21/ids?includeOrthologs="human"'
curl 'http://localhost:3001/hpi/search/api'

POST
curl -H "Content-Type: application/json" -X POST "http://localhost:3001/hpi/search" -d '{ "type": "input string", "idSource": "id source input string", "ids": ["id 1", "id 2", "id 3"], "threshold": 0.5, "thresholdType": "a number", "additionalFlags": { "key1": "value1", "key2": "value2" } }'

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
var RQLQueryParser = require("../middleware/RQLQueryParser");
var DecorateQuery = require("../middleware/DecorateQuery");
var APIMethodHandler = require("../middleware/APIMethodHandler");
var Limiter = require("../middleware/Limiter");

router.use(httpParams);
router.use(authMiddleware);

// handle GET hpi/search/
// Not sure what to return here
router.get("/", [
	bodyParser.urlencoded({extended: true}),
	function(req, res, next){
		res.write("--- acknowledged GET for hpi/search \n");
    res.end();
	}
])

// POST hpi/search/
// Given an input set of Host IDs and match parameters, return matching experiments and ID lists
// curl -H "Content-Type: application/json" -X POST "http://localhost:3001/hpi/search" -d '{ "type": "input string", "idSource": "id source input string", "ids": ["id 1", "id 2", "id 3"], "threshold": 0.5, "thresholdType": "a number", "additionalFlags": { "key1": "value1", "key2": "value2" } }'
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
    res.write("--- acknowledged POST for hpi/search \n");
    res.end();
	}
])

// GET hpi/search/experiment
// Maybe a 404 or a list of all experiment ids
router.get("/experiment", [
  bodyParser.urlencoded({extended: true}),
  function(req, res, next){
		req.call_collection = "transcriptomics_experiment";
		req.call_method = "query";
		req.call_params = ["&q=*:*"]; // default is 25 rows; add &rows=1000 to adjust
		req.queryType = "solr";
		next();
	},
  //DecorateQuery,
	Limiter,
	APIMethodHandler,
	function(req, res, next){

    if(res.results && res.results.response && res.results.response.docs){
			var experiments = res.results.response.docs.map(function(d){
				return {
					eid: d.eid
				}
			});
			res.json(experiments);
		}else{
      res.write("--- acknowledged GET for hpi/search/experiemnt \n");
    }
    res.end();

	}
]);

// GET hpi/search/experiment/{experimentIdentifier}
// The details of an experiment, as showin in the primary endpoint
router.get("/experiment/:id", [
  bodyParser.urlencoded({extended: true}),
  function(req, res, next){
		req.call_collection = "transcriptomics_experiment";
		req.call_method = "query";

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ["&q=eid:" + req.params.id];
    } else {
      req.call_params = ["&q=accession:" + req.params.id];
    }

		req.queryType = "solr";
		next();
	},
	//DecorateQuery,
	Limiter,
	APIMethodHandler,
	function(req, res, next){

    if(res.results && res.results.response && res.results.response.docs){
			res.json(res.results.response.docs);
		}else{
      res.write("--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier} \n");
    }
    res.end();

	}
]);

// GET hpi/search/experiment/{experimentIdentifier}/idList/{listIdentifier}
// The details of an experiment, as shown in the primary endpoint
router.get("/experiment/:id/idList/:id_list", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    req.call_collection = "transcriptomics_sample";
		req.call_method = "query";

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ["&q=eid:" + req.params.id];
    } else {
      req.call_params = ["&q=accession:" + req.params.id];
    }

    // accept either a list of accessions or sample ids
    if (!isNaN(req.params.id_list) && parseInt(Number(req.params.id_list)) == req.params.id_list) {
      // this was a sample id (which has a gene list)
      req.call_params[0] = req.call_params[0] + ["+AND+pid:" + req.params.id_list];
    } else {
      // put together the id_list portion of the query string 'samples:(*GSM432865* OR *GSM432861*)'
      req.call_params[0] = req.call_params[0] + "+AND+samples:(*" + req.params.id_list.replace(',', '*+OR+*') + "*)";
    }    

		req.queryType = "solr";
		next();

	},
  //DecorateQuery
  Limiter,
  APIMethodHandler,
  function(req, res, next){
    if(res.results && res.results.response && res.results.response.docs){
			res.json(res.results.response.docs);
		}else{
      res.write("--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier}/idList/{listIdentifier} \n");
    }
    res.end();
  }
]);

// GET hpi/search/experiment/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs="human">
// Return the ids for the idList.  If the optional includeOrthologs parameter is supplied,
// return a second column with lorthologous ids from that organism
router.get("/experiment/:id/idList/:id_list/ids", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    req.call_collection = "transcriptomics_sample";
    req.call_method = "query";

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ["&q=eid:" + req.params.id];
    } else {
      req.call_params = ["&q=accession:" + req.params.id];
    }

    // put together the id_list portion of the query string 'samples:(*GSM432865* OR *GSM432861*)'
    req.call_params[0] = req.call_params[0] + "+AND+samples:(*" + req.params.id_list.replace(',', '*+OR+*') + "*)";

    req.queryType = "solr";
    next();
	},
  //DecorateQuery
  Limiter,
  APIMethodHandler,
  function(req, res, next){
    if(res.results && res.results.response && res.results.response.docs){
      var samples = res.results.response.docs.map(function(d){
				return {
					pid: d.pid
				}
			});
			res.json(samples);
		}else{
      res.write("--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier}/idList/{listIdentifier}/ids \n");
    }
    res.end();
  }
]);

// GET hpi/search/api
// Supplies information specific to this BRC's implementation of the API
router.get("/api", [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){

    // create the structure to hold the input types
    var support = {
      'inputTypes': [],
    };

    // for each input type, provide the necessary info
    var gene_input = {
      'name': 'genes',
      'displayName': 'Gene List',
      'description': 'A list of genes to match against experiments',
      'idSources': ['NCBI GEO Accession', 'PATRIC'],
      'thresholdTypes': [{
        'name': 'percent_matched',
        'displayName': 'Percent Matched',
        'description': 'Percent of provided genes matched to the genes in an experiment',
        'min': 0.0,
        'max': 100.0
      },{
        'name': 'log_ratio',
        'displayName': 'Log Ratio',
        'description': 'A differential expression value specified as log2 (test/control)',
        'min': -5.0,
        'max': 5.0
      }],
      'additionalFlags': [{
        'key':'useOrthology',
        'jsonType':'boolean',
        'description':'If the useOrthology flag is set, returns a second column with orhologous IDs from that organism.'}]

    };
    support.inputTypes.push(gene_input);

    res.write(JSON.stringify(support));
    res.end();
	}
]);

module.exports = router;
