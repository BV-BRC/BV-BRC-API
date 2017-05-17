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
//const ID_SOURCE_PATRIC = 'patric';
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
      res.write('422: unrecognized input type');
      res.end();
    }

    var query = [];
    // accept a list of feature_ids or alt_locus_tags
    switch(req.body.idSource){
			// case ID_SOURCE_PATRIC:
      //   query.push('&q=feature_id:');
      //   break;
      case ID_SOURCE_ALT_LOCUS_TAG:
        query.push('&q=alt_locus_tag:');
        break;
      default:
        // return 422
        res.write('422: unrecognized input type');
        res.end();
        break;
    }

    // add the ids to the query
    query.push('(' + req.body.ids.join('+OR+') + ')');

    // if we're using min log_ratio
    if (req.body.thresholdType == THRESHOLD_LOG_RATIO) {
      var pos_thresh = Math.abs(req.body.threshold);
      var neg_thresh = -1.0 * Math.abs(req.body.threshold);
      query.push('AND (log_ratio:['+pos_thresh+' TO *] OR log_ratio:[* TO '+neg_thresh+'])');
    }

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
      var pids = [];
      var validIdCount = 0;

      // apply threshold and add the ids to the query
      var thresh_eval = null;
      var thresh = null;

      switch(req.body.thresholdType){
  			case THRESHOLD_PERCENT:
          thresh = Math.floor((req.body.threshold/100.0) * req.body.ids.length);
          thresh_eval = (count, threshold) => {
            if (count >= threshold) { return true } else { return false }
           };
          break;
        case THRESHOLD_LOG_RATIO:
          thresh_eval = (count, threshold) => { return true };
          break;
        default:
          // return 422
          res.write('422: unrecognized input type');
          res.end();
          break;
      }

      for (var i=0; i < res.results.facet_counts.facet_fields.pid.length; i+=2) {
        // check the odd indices for count and apply thresholding
        var pid = res.results.facet_counts.facet_fields.pid[i];
        var count = res.results.facet_counts.facet_fields.pid[i+1];
        if (thresh_eval(count, thresh)) {
          pids.push(pid);
          if (count > validIdCount) validIdCount = count;
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

      // stash the pid_count_map in the request
      req.validIdCount = validIdCount;

      next();
    } else {
      var empty = [];
      res.write(JSON.stringify(empty));
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
      var empty = [];
      res.write(JSON.stringify(empty));
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
      var exp_provenance_map = {};
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

            // XXX using log_ratio filter, we toss out the genes that were 'insignificant' to start, so there may be more valid ids in the list, just not significant
            validIdCount: req.validIdCount, // max of gene ids in any sample we found

            // XXX no idea what this is meant to convey for our data
            experimentSignificance: 0.0,
            significanceType: 'TBD',
            idLists: [],
          };

        exp_map[exp['eid']] = exp_trans;
        exp_provenance_map[exp['eid']] = exp.author + ' from ' + exp.institution;
      }

      // prepare and attach samples to experiments
      for (i in req.samples){
        var sample = req.samples[i];
        var exp = exp_map[sample['eid']];
        var exp_provenance = exp_provenance_map[sample['eid']];

        var sample_trans = {
              listIdentifier: sample.pid,
              displayName: sample.expname,
              description: sample.expname,
              uri: PATRIC_URL + '/view/ExperimentComparison/' + sample.eid + '#view_tab=comparisons',
              type: INPUT_TYPE_GENE,
              provenance: exp_provenance, // this should belong at the experiment level (and get rid of exp_provenance_map)
              significance: sample.sig_z_score,
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
      var empty = [];
      res.write(JSON.stringify(empty));
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
		req.call_params = ['&q=condition:"host response"&rows=25000'];
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
					experimentIdentifier: d.eid
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

  // Step 1: get the samples for the eid
  function(req, res, next){
		req.call_collection = 'transcriptomics_sample';
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

  function(req, res, next) {

    if(res.results && res.results.response && res.results.response.docs){

      // stash the samples in the request
      req.samples = res.results.response.docs.map(function(d){
				return {
          experimentIdentifier: d.eid,
          listIdentifier: d.pid,
          accession: d.accession,
          expname: d.expname,
          description: d.description,
          accession: d.accession,
          genes: d.genes,
          organism: d.organism,
          sig_log_ratio: d.sig_log_ratio,
          expmean: d.expmean,
          date_inserted: d.date_inserted,
          date_modified: d.date_modified,
				}
			});

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
    } else {
      res.write('500: Internal error');
      res.end();
    }
	},
	//DecorateQuery,
	//Limiter,
	APIMethodHandler,
	function(req, res, next){

    if(res.results && res.results.response && res.results.response.docs){

      // this mapping is because we want to show 'experimentIdentifier' vs 'eid'
      var experiments = res.results.response.docs.map(function(d){
				return {
					experimentIdentifier: d.eid,
          title: d.title,
          description: d.description,
          accession: d.accession,
          samples: req.samples,
          genes: d.genes,
          genome_ids: d.genome_ids,
          organism: d.organism,
          pmid: d.pmid,
          date_inserted: d.date_inserted,
          date_modified: d.date_modified,
          institution: d.institution,
          author: d.author,
          condition: d.condition
				}
			});
			res.json(experiments);
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

      // this mapping is because we want to show 'experimentIdentifier' vs 'eid' and 'listIdentifier' vs 'pid'
      var samples = res.results.response.docs.map(function(d){
				return {
					experimentIdentifier: d.eid,
          listIdentifier: d.pid,
          accession: d.accession,
          expname: d.expname,
          description: d.description,
          accession: d.accession,
          genes: d.genes,
          organism: d.organism,
          sig_log_ratio: d.sig_log_ratio,
          expmean: d.expmean,
          date_inserted: d.date_inserted,
          date_modified: d.date_modified,
				}
			});
			res.json(samples);
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

    // accept a sample id (which corresponds to a list of genes
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
      'idSources': [ID_SOURCE_ALT_LOCUS_TAG],
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
