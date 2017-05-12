/*

Host-Pathogen Interaction (HPI) Search APIs

Use-Case: Given a defined list of host genes/pathways/GO terms/etc, find the
experiments (transcriptional regulation studies / genetic or small molecule
screens / population-level evolutionary analysis /etc) supported by other BRCs
might be of interest (i.e. yield a similar set of results)


GETs
curl 'http://localhost:3001/hpi/search'
curl 'http://localhost:3001/hpi/search/experiment'
curl 'http://localhost:3001/hpi/search/experiment/GSE79731'
curl 'http://localhost:3001/hpi/search/experiment/GSE79731/idList/100000211'
curl 'http://localhost:3001/hpi/search/experiment/GSE79731/idList/100000211/ids'
curl 'http://localhost:3001/hpi/search/experiment/GSE79731/idList/100000211/ids?includeOrthologs='human''
curl 'http://localhost:3001/hpi/search/api'

POST
curl -H 'Content-Type: application/json' -X POST 'http://localhost:3001/hpi/search' -d '{ "type": "gene", "idSource": "alt_locus_tag", "ids": ["NP_031402.3", "XP_011246971.1"], "threshold": 0.5, "thresholdType": "percent_matched", "organism": "Mus musculus", "additionalFlags": { "useOrthology": "false" } }'

*/


// import dependencies
var express = require('express');
var router = express.Router({strict: true, mergeParams: true});
var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var config = require('../config');
var bodyParser = require('body-parser');
var debug = require('debug')('p3api-server:route/hpiSearchRouter');
var httpParams = require('../middleware/http-params'); // checks for stuff starting with http_ in the query and sets it as a header
var authMiddleware = require('../middleware/auth');
var querystring = require('querystring');
var RQLQueryParser = require('../middleware/RQLQueryParser');
var APIMethodHandler = require('../middleware/APIMethodHandler');
var Limiter = require('../middleware/Limiter');

// constants and magic words
const INPUT_TYPE_GENE = 'gene';
const ID_SOURCE_PATRIC = 'patric';
const ID_SOURCE_ALT_LOCUS_TAG = 'alt_locus_tag';
const THRESHOLD_PERCENT = 'percent_matched';
const THRESHOLD_LOG_RATIO = 'log_ratio';
const FLAG_ORTHOLOGY = 'useOrthology';

var PATRIC_URL = config.get("distributeURL");


router.use(httpParams);
router.use(authMiddleware);

// handle GET hpi/search/
// Not sure what to return here
router.get('/', [
	bodyParser.urlencoded({extended: true}),
	function(req, res, next){
		res.write('--- acknowledged GET for hpi/search \n');
    res.end();
	}
]);

// POST hpi/search/
// Given an input set of Host IDs and match parameters, return matching experiments and ID lists
// curl -H 'Content-Type: application/json' -X POST 'http://localhost:3001/hpi/search' -d '{ "type": "gene", "idSource": "alt_locus_tag", "ids": ["NP_031402.3", "XP_011246971.1"], "threshold": 0.5, "thresholdType": "percent_matched", "organism": "Mus musculus", "additionalFlags": { "useOrthology": "false" } }'
router.post('/', [
	bodyParser.json(),

  // Step 1: Assemble the list of matching genes
	function(req, res, next){
    //debug('req.body: ', req.body);
    
    req.call_collection = 'transcriptomics_gene';
		req.call_method = 'query';

    if (req.body.type != INPUT_TYPE_GENE){
      // return 422
    }

    var query = [];
    // accept a list of feature_ids or alt_locus_tags
    switch(req.body.idSource){
			case ID_SOURCE_PATRIC:
        query.push('&q=feature_id:');
        break;
      case ID_SOURCE_ALT_LOCUS_TAG:
        query.push('&q=alt_locus_tag:');
        break;
      default:
        // return 422
        break;
    }

    // add the ids to the query
    query.push('(' + req.body.ids.join('+OR+') + ')');

    // facet on sample
    query.push('&facet.field=pid&facet.mincount=1&facet=on');

    // increase row limit
    query.push('&rows=25000');

    req.call_params = [query.join('')];
		req.queryType = 'solr';

		next();
	},
  Limiter,
	APIMethodHandler,

  // Step 2: Gather the metadata for the matching samples
	function(req, res, next){

    // ensure we got everything we expected in the response
    if (res.results && res.results.response && res.results.facet_counts &&
      res.results.facet_counts.facet_fields && res.results.facet_counts.facet_fields.pid) {

      req.call_collection = 'transcriptomics_sample';
  		req.call_method = 'query';

      var query = [];

      // add the ids to the query
      var pids = [];
      for (var i in res.results.facet_counts.facet_fields.pid){
        if(i % 2 === 0) { // index is even
          pids.push(res.results.facet_counts.facet_fields.pid[i]);
        }
      }
      query.push('&q=pid:(' + pids.join('+OR+') + ')');

      // facet on experiment
      query.push('&facet.field=eid&facet.mincount=1&facet=on');

      // increase row limit
      query.push('&rows=25000');

      req.call_params = [query.join('')];
  		req.queryType = 'solr';

      // // stash the genes in the request
      // req.genes = res.results.response.docs;

      next();
    } else {
      // no results XXX bail?
      res.write('--- acknowledged POST for hpi/search \n');
      res.end();
    }


	},
  Limiter,
  APIMethodHandler,

  // Step 3: Gather the metadata for the matching experiments
  function(req, res, next){

    if (res.results && res.results.response && res.results.response.docs) {

      // stash the samples in the request
      req.samples = res.results.response.docs;

      // prepare the query for experiments
      req.call_collection = 'transcriptomics_experiment';
      req.call_method = 'query';

      var query = [];

      // add the ids to the query
      var eids = [];
      for (var i in res.results.facet_counts.facet_fields.eid){
        if(i % 2 === 0) { // index is even
          eids.push(res.results.facet_counts.facet_fields.eid[i]);
        }
      }
      query.push('&q=eid:(' + eids.join('+OR+') + ')');

      // increase row limit
      query.push('&rows=25000');

      req.call_params = [query.join('')];
      req.queryType = 'solr';

      next();
		}else{
      res.write('--- acknowledged POST for hpi/search \n');
      res.end();
    }

  },
  Limiter,
  APIMethodHandler,

  // Step 4: Prepare the final response
  // Note: it would have been better to just return sample and experiment ids
  //       instead of putting this whole response together, since we have APIs
  //       to get the metadata elsewhere.
  function(req, res, next){

    if (res.results && res.results.response && res.results.response.docs) {

      // prepare the output for the experiments
      var exp_map = {};
      for (i in res.results.response.docs){
        var exp = res.results.response.docs[i];

        var exp_trans = {
            experimentIdentifier: exp.accession,
            displayName: exp.title,
            type: 'transcriptomics',
            description: exp.description,
            uri: PATRIC_URL + '/view/ExperimentComparison/' + exp.eid,
            species: exp.organism,
            genomeVersion: exp.genome_ids,
            validIdCount: 'TBD',
            experimentSignificance: 0.0,
            significanceType: req.body.thresholdType,
            idLists: [],
          };

        exp_map[exp['eid']] = exp_trans;

      }

      // prepare and attach samples to experiments
      for (i in req.samples){
        var sample = req.samples[i];
        var exp = exp_map[sample['eid']];

        var sample_trans = {
          listIdentifier: sample.pid,
              displayName: sample.expname,
              description: sample.expname,
              uri: PATRIC_URL + '/view/ExperimentComparison/' + sample.eid + '#view_tab=comparisons',
              type: INPUT_TYPE_GENE,
              provenance: 'TBD',
              significance: 'TBD',
        };

        exp.idLists.push(sample_trans);

      }

      // output the whole shebang
      var experiments = [];
      for (var k in exp_map) {
        // use hasOwnProperty to filter out keys from the Object.prototype
        if (exp_map.hasOwnProperty(k)) {
            experiments.push(exp_map[k]);
        }
      }

      // output the experiments
      res.write(JSON.stringify(experiments));

    }else{
      res.write('--- acknowledged POST for hpi/search \n');
    }
    res.end();
  }
]);

// GET hpi/search/experiment
// Maybe a 404 or a list of all experiment ids
router.get('/experiment', [
  bodyParser.urlencoded({extended: true}),
  function(req, res, next){
		req.call_collection = 'transcriptomics_experiment';
		req.call_method = 'query';
		req.call_params = ['&q=*:*&rows=25000']; // default is 25 rows; add &rows=1000 to adjust
		req.queryType = 'solr';
		next();
	},
  //DecorateQuery,
	//Limiter,
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
      res.write('--- acknowledged GET for hpi/search/experiemnt \n');
    }
    res.end();

	}
]);

// GET hpi/search/experiment/{experimentIdentifier}
// The details of an experiment, as showin in the primary endpoint
router.get('/experiment/:id', [
  bodyParser.urlencoded({extended: true}),
  function(req, res, next){
		req.call_collection = 'transcriptomics_experiment';
		req.call_method = 'query';

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ['&q=eid:' + req.params.id];
    } else {
      req.call_params = ['&q=accession:' + req.params.id];
    }

		req.queryType = 'solr';
		next();
	},
	//DecorateQuery,
	//Limiter,
	APIMethodHandler,
	function(req, res, next){

    if(res.results && res.results.response && res.results.response.docs){
			res.json(res.results.response.docs);
		}else{
      res.write('--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier} \n');
    }
    res.end();

	}
]);

// GET hpi/search/experiment/{experimentIdentifier}/idList/{listIdentifier}
// The details of an experiment, as shown in the primary endpoint
router.get('/experiment/:id/idList/:id_list', [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    req.call_collection = 'transcriptomics_sample';
		req.call_method = 'query';

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ['&q=eid:' + req.params.id];
    } else {
      req.call_params = ['&q=accession:' + req.params.id];
    }

    // accept a sample id (which corresponds to a list of genes)
    req.call_params[0] = req.call_params[0] + ['+AND+pid:' + req.params.id_list];

		req.queryType = 'solr';
		next();

	},
  Limiter,
  APIMethodHandler,
  function(req, res, next){
    if(res.results && res.results.response && res.results.response.docs){
			res.json(res.results.response.docs);
		}else{
      res.write('--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier}/idList/{listIdentifier} \n');
    }
    res.end();
  }
]);

// GET hpi/search/experiment/{experimentIdentifier}/idList/{listIdentifier}/ids<?includeOrthologs='human'>
// Return the ids for the idList.  If the optional includeOrthologs parameter is supplied,
// return a second column with lorthologous ids from that organism
router.get('/experiment/:id/idList/:id_list/ids', [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){
    req.call_collection = 'transcriptomics_gene';
    req.call_method = 'query';

    // check if the id is a number or not (number=eid, not=accession)
    if (!isNaN(req.params.id) && parseInt(Number(req.params.id)) == req.params.id) {
      req.call_params = ['&q=eid:' + req.params.id];
    } else {
      req.call_params = ['&q=accession:' + req.params.id];
    }

    // accept a sample id (which corresponds to a list of genes)
    req.call_params[0] = req.call_params[0] + ['+AND+pid:' + req.params.id_list];

    // set the row limit
    req.call_params[0] = req.call_params[0] + ['&rows=25000'];

    req.queryType = 'solr';
    next();
	},
  Limiter,
  APIMethodHandler,
  function(req, res, next){
    if(res.results && res.results.response && res.results.response.docs){
      var samples = res.results.response.docs.map(function(d){
				return {
					patric_id: d.feature_id,
          alt_locus_tag: d.alt_locus_tag
				}
			});
			res.json(samples);
		}else{
      res.write('--- acknowledged GET for hpi/search/experiemnt/{experimentIdentifier}/idList/{listIdentifier}/ids \n');
    }
    res.end();
  }
]);

// GET hpi/search/api
// Supplies information specific to this BRC's implementation of the API
router.get('/api', [
  bodyParser.urlencoded({extended: true}),
	function(req, res, next){

    // create the structure to hold the input types
    var support = {
      'inputTypes': [],
    };

    // for each input type, provide the necessary info
    var gene_input = {
      'name': INPUT_TYPE_GENE,
      'displayName': 'Gene List',
      'description': 'A list of genes to match against experiments',
      'idSources': [ID_SOURCE_PATRIC, ID_SOURCE_ALT_LOCUS_TAG],
      'thresholdTypes': [{
        'name': THRESHOLD_PERCENT,
        'displayName': 'Percent Matched',
        'description': 'Percent of provided genes matched to the genes in an experiment',
        'min': 0.0,
        'max': 100.0
      },{
        'name': THRESHOLD_LOG_RATIO,
        'displayName': 'Log Ratio',
        'description': 'A differential expression value specified as log2 (test/control)',
        'min': -5.0,
        'max': 5.0
      }],
      'additionalFlags': [{
        'key':FLAG_ORTHOLOGY,
        'jsonType':'boolean',
        'description':'If the useOrthology flag is set, returns a second column with orhologous IDs from that organism.'}]

    };
    support.inputTypes.push(gene_input);

    res.write(JSON.stringify(support));
    res.end();
	}
]);

module.exports = router;
