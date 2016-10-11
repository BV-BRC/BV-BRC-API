var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var config = require("../config");
var bodyParser = require("body-parser");
var rql = require("solrjs/rql");
var debug = require('debug')('p3api-server:JBrowse');
var SolrQueryParser = require("../middleware/SolrQueryParser");
var RQLQueryParser = require("../middleware/RQLQueryParser");
var DecorateQuery = require("../middleware/DecorateQuery");
var PublicDataTypes = require("../middleware/PublicDataTypes");
var authMiddleware = require("../middleware/auth");
var APIMethodHandler = require("../middleware/APIMethodHandler");
var httpParams = require("../middleware/http-params");
var Limiter = require("../middleware/Limiter");
// router.use(httpParams);

// router.use(authMiddleware);

var apiRoot = config.get("jbrowseAPIRoot");

function generateRefSeqs(req,res,next){
	return '[{"sid":"1094551.3","seqChunkSize":78236,"start":0,"seqDir":"","name":"AIME01000001","length":78236,"end":78236,"accn":"AIME01000001"},{"sid":"1094551.3","seqChunkSize":136015,"start":0,"seqDir":"","name":"AIME01000002","length":136015,"end":136015,"accn":"AIME01000002"},{"sid":"1094551.3","seqChunkSize":400537,"start":0,"seqDir":"","name":"AIME01000003","length":400537,"end":400537,"accn":"AIME01000003"},{"sid":"1094551.3","seqChunkSize":559503,"start":0,"seqDir":"","name":"AIME01000004","length":559503,"end":559503,"accn":"AIME01000004"},{"sid":"1094551.3","seqChunkSize":6253,"start":0,"seqDir":"","name":"AIME01000005","length":6253,"end":6253,"accn":"AIME01000005"},{"sid":"1094551.3","seqChunkSize":368863,"start":0,"seqDir":"","name":"AIME01000006","length":368863,"end":368863,"accn":"AIME01000006"},{"sid":"1094551.3","seqChunkSize":2535,"start":0,"seqDir":"","name":"AIME01000007","length":2535,"end":2535,"accn":"AIME01000007"},{"sid":"1094551.3","seqChunkSize":5334,"start":0,"seqDir":"","name":"AIME01000008","length":5334,"end":5334,"accn":"AIME01000008"},{"sid":"1094551.3","seqChunkSize":6500,"start":0,"seqDir":"","name":"AIME01000009","length":6500,"end":6500,"accn":"AIME01000009"},{"sid":"1094551.3","seqChunkSize":3562,"start":0,"seqDir":"","name":"AIME01000010","length":3562,"end":3562,"accn":"AIME01000010"},{"sid":"1094551.3","seqChunkSize":12776,"start":0,"seqDir":"","name":"AIME01000011","length":12776,"end":12776,"accn":"AIME01000011"},{"sid":"1094551.3","seqChunkSize":8474,"start":0,"seqDir":"","name":"AIME01000012","length":8474,"end":8474,"accn":"AIME01000012"},{"sid":"1094551.3","seqChunkSize":3218,"start":0,"seqDir":"","name":"AIME01000013","length":3218,"end":3218,"accn":"AIME01000013"},{"sid":"1094551.3","seqChunkSize":1065,"start":0,"seqDir":"","name":"AIME01000014","length":1065,"end":1065,"accn":"AIME01000014"},{"sid":"1094551.3","seqChunkSize":3412,"start":0,"seqDir":"","name":"AIME01000015","length":3412,"end":3412,"accn":"AIME01000015"},{"sid":"1094551.3","seqChunkSize":2868,"start":0,"seqDir":"","name":"AIME01000016","length":2868,"end":2868,"accn":"AIME01000016"},{"sid":"1094551.3","seqChunkSize":3686,"start":0,"seqDir":"","name":"AIME01000017","length":3686,"end":3686,"accn":"AIME01000017"},{"sid":"1094551.3","seqChunkSize":1858,"start":0,"seqDir":"","name":"AIME01000018","length":1858,"end":1858,"accn":"AIME01000018"},{"sid":"1094551.3","seqChunkSize":3144,"start":0,"seqDir":"","name":"AIME01000019","length":3144,"end":3144,"accn":"AIME01000019"},{"sid":"1094551.3","seqChunkSize":1499,"start":0,"seqDir":"","name":"AIME01000020","length":1499,"end":1499,"accn":"AIME01000020"},{"sid":"1094551.3","seqChunkSize":36781,"start":0,"seqDir":"","name":"AIME01000021","length":36781,"end":36781,"accn":"AIME01000021"}]'
}

function generateTrackList(req,res,next){
	//console.log("Generate Track List: ", req.params.id);
	return JSON.stringify({
		"tracks": [
			{
				"type": "SequenceTrack",
				"storeClass": "JBrowse/Store/SeqFeature/REST",
				"baseUrl":    apiRoot + "/genome/" + req.params.id,
				// "urlTemplate": apiRoot + "/sequence/{refseq}",
				"key": "Reference sequence",
				"label": "ReferenceSequence",
				"chunkSize": 20000,
				"maxExportSpan": 10000000,
				"region_stats": false,
				"pinned": true
			}
			,{
				"type": "JBrowse/View/Track/CanvasFeatures",
				// "urlTemplate": apiRoot + "/genome/" +req.params.id + "/{refseq}?annotation=PATRIC",
				// "storeClass": "JBrowse/Store/SeqFeature/NCList",
				"storeClass": "JBrowse/Store/SeqFeature/REST",
				"baseUrl":    apiRoot + "/genome/" + req.params.id,
				"key": "PATRIC Annotation",
				"label": "PATRICGenes",
				"query": {
					annotation: "PATRIC"
				},
				"style": {
                    "showLabels": true,
                    "showTooltips":true,
					"label": "gene,patric_id", //"function( feature ) { return feature.get('patric_id') }" //both the function and the attribute list work. but label doesn't show using HTMLFeatures only CanvasFeatures
                    "color": "#17487d"
				},
				"hooks": {
					"modify": "function(track, feature, div) { div.style.padding='4px'; div.style.backgroundColor = ['#17487d','#5190d5','#c7daf1'][feature.get('phase')];}"
				},
				"tooltip": "<div style='line-height:1.7em'><b>{patric_id}</b> | {refseq_locus_tag} | {alt_locus_Tag} | {gene}<br>{product}<br>{type}: {start_str} .. {end} ({strand_str})<br> <i>Click for detail information</i></div>",
				"metadata": {
					"Description": "PATRIC annotated genes"
				},
				"maxExportFeatures": 10000,
				"maxExportSpan": 10000000,
				"region_stats":false 
			}
			, {
				"type": "JBrowse/View/Track/CanvasFeatures",
				// "urlTemplate":  apiRoot + "/genome/" +req.params.id + "/{refseq}?annotation=RefSeq",
				// "storeClass": "JBrowse/Store/SeqFeature/NCList",
			    "storeClass": "JBrowse/Store/SeqFeature/REST",
				"baseUrl":    apiRoot + "/genome/" + req.params.id,
				"query": {
					annotation: "RefSeq"
				},
				"key": "RefSeq Annotation",
				"label": "RefSeqGenes",
				"style": {
                    "showLabels": true,
                    "showTooltips":true,
					"className": "feature3",
					"label": "gene,protein_id,refseq_locus_tag,feature_type",//"function( feature ) { return feature.get('refseq_locus_tag') }", //label attribute doesn't seem to work on HTMLFeatures
                    "color": "#4c5e22"
				},
				"hooks": {
					"modify": "function(track, feature, div) { div.style.backgroundColor = ['#4c5e22','#9ab957','#c4d59b'][feature.get('phase')];}" //these don't seem to work on CanvasFeatures
				},
				"tooltip": "<div style='line-height:1.7em'><b>{refseq_locus_tag}</b> | {gene}<br>{product}<br>{type}: {start_str} .. {end} ({strand_str})<br> <i>Click for detail information</i></div>",
				"metadata": {
					"Description": "RefSeq annotated genes"
				},
				"maxExportFeatures": 10000,
				"maxExportSpan": 10000000,
				"region_stats":false 
			}
		],
		"names" : {
			"url" : "names/",
			"type" : "REST"
		},
		"formatVersion": 1
	})

}

router.use(httpParams);
router.use(authMiddleware);
router.use(PublicDataTypes);

router.get("/genome/:id/trackList", [
	function(req,res,next){
		res.write(generateTrackList(req,res,next));
		res.end();
	}
])

router.get("/genome/:id/tracks", [
	function(req,res,next){
		res.write("[]");
		res.end();
	}
])

router.get("/genome/:id/stats/global",[
	function(req,res,next){
		res.write('{}');
		res.end();
	}
])

router.get("/genome/:id/stats/region/:feature_id",[
	function(req,res,next){
		res.end();
	}
])

router.get("/genome/:id/stats/regionFeatureDensities/:sequence_id",[
	function(req,res,next){
		res.end();
	}
])



router.get("/genome/:id/features/:feature_id",[
	function(req,res,next){
		//console.log("req.params: ", req.params, "req.query: ", req.query);
		var start = req.query.start || req.params.start;
		var end = req.query.end || req.params.end;
		var annotation = req.query.annotation || req.params.annotation || "PATRIC"
		req.call_collection = "genome_feature";
		req.call_method = "query";
		var st = "and(gt(start,"+start+"),lt(start,"+end+"))"
		var en = "and(gt(end,"+start+"),lt(end,"+end+"))"
		var over = "and(lt(start," + start + "),gt(end," + end + "))";
		if (req.query && req.query["reference_sequences_only"]){
			req.call_collection = "genome_sequence";
			req.call_params = ["and(eq(genome_id," + req.params.id + "),eq(accession," +req.params.feature_id + "))"];
		}else{
			req.call_params = ["and(eq(genome_id," + req.params.id + "),eq(accession," +req.params.feature_id + "),eq(annotation," + annotation + "),or(" +st+"," + en + "," + over + "),ne(feature_type,source))"];
		}
		req.queryType = "rql";
		//console.log("CALL_PARAMS: ", req.call_params);
		next();
	},
	RQLQueryParser,
	DecorateQuery,
	Limiter,
	APIMethodHandler,
	function(req,res,next){
		if (req.call_collection=="genome_sequence"){
			if (res.results && res.results.response && res.results.response.docs){
				var refseqs = res.results.response.docs.map(function(d){
					return {
						length: d.length,
						name: d.accession,
						accn: d.accession,
						type: "reference",
						score: d.gc_content,
						sid: d.genome_id,
						start: 0,
						end: d.length,
						seq: d.sequence,
						seqChunkSize: d.length
					}
				})
				res.json({features: refseqs});
				res.end();
			}

		}else{
			next();
		}
	},
	function(req,res,next){
		//console.log("res.results: ", res.results)
		if (res.results && res.results.response && res.results.response.docs){
			var features = res.results.response.docs.map(function(d){
					d.seq= d.na_sequence;
					d.type=d.feature_type;
					d.name=d.accession;
					d.uniqueID=d.feature_id;
					d.strand=(d.strand=="+")?1:-1;
					d.phase=(d.feature_type=="CDS")?0:((d.feature_type=="RNA")?1:2);
					return d;
			})
			//console.log("FEATURES: ", features)
			res.json({features: features});
			res.end();
		}
	}
])

router.get("/genome/:id/refseqs", [
	function(req,res,next){
		req.call_collection = "genome_sequence";
		req.call_method = "query";
		req.call_params = ["&eq(genome_id," + req.params.id + ")&select(topology,gi,accession,length,sequence_id,gc_content,owner,sequence_type,taxon_id,public,genome_id,genome_name,date_inserted,date_modified)&sort(+accession)&limit(1000)"];
		req.queryType = "rql";
		next();
	},
	RQLQueryParser,
	DecorateQuery,
	Limiter,
	APIMethodHandler,
	function(req,res,next){
		//console.log("Res.results: ", res.results);
		if (res.results && res.results.response && res.results.response.docs){
			var refseqs = res.results.response.docs.map(function(d){
				return {
					length: d.length,
					name: d.accession,
					accn: d.accession,
					sid: d.genome_id,
					start: 0,
					end: d.length,
					seqDir: "",
					seqChunkSize: d.length
				}
			})
			res.json(refseqs);
			res.end();
		}
	}
])

module.exports = router;
