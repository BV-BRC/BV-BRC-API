const Deferred = require("promised-io/promise").Deferred;
const all = require('promised-io/promise').all;
const when = require('promised-io/promise').when;
const debug = require('debug')('p3api-server:TranscriptomicsGene');
const request = require('request');
const config = require("../config");
const distributeURL = config.get("distributeURL");
const workspaceAPI = config.get("workspaceAPI");

function getWorkspaceObjects(paths, metadataOnly, token){
	const def = new Deferred();

	if(!(paths instanceof Array)){
		paths = [paths];
	}
	paths = paths.map(decodeURIComponent);

	request({
		method: "POST",
		url: workspaceAPI,
		json: true,
		body: {
			id: 1,
			method: "Workspace.get",
			version: "1.1",
			params: [{objects: paths, metadata_only: metadataOnly}]
		},
		headers: {
			"accept": "application/json",
			"content-type": "application/json",
			"authorization": token
		}
	}, function(err, resObj, results){
		if(err){
			debug("Error retrieving object from workspace: ", err);

			def.reject(err);
			return;
		}
		if(results.result){

			// const data = [];

			const defs = results.result[0].map(function(obj){
				// debug("reading obj0: ", obj[0]);
				// debug("reading obj1: ", obj[1]);
				const meta = {
					name: obj[0][0],
					type: obj[0][1],
					path: obj[0][2],
					creation_time: obj[0][3],
					id: obj[0][4],
					owner_id: obj[0][5],
					size: obj[0][6],
					userMeta: obj[0][7],
					autoMeta: obj[0][8],
					user_permissions: obj[0][9],
					global_permission: obj[0][10],
					link_reference: obj[0][11]
				};
				// debug("meta: ", meta);
				if(metadataOnly){
					// data.push(meta);
					// return true;
					return meta;
					// def.resolve(meta);
					// return true;
				}
				if(!meta.link_reference){
					// data.push({metadata: meta, data: obj[1]});
					// return true;
					return ({metadata: meta, data: obj[1]});
					// def.resolve({metadata: meta, data: obj[1]});
					// return true;
				}else{

					const headers = {
						"Authorization": "OAuth " + token
					};

					// debug("headers: ", headers);
					const defShock = new Deferred();
					request({
						method: 'GET',
						url: meta.link_reference + "?download",
						headers: headers
					}, function(err, res, d){
						// debug("err", err);
						// debug("res: ", res);
						// debug("downloaded: ", d);
						defShock.resolve({
							metadata: meta,
							data: d
						});
						// return true;
					});
					return defShock.promise;
				}
			});
			// debug("defs: ", defs);
			all(defs).then(function(d){
				// debug("all defs are resolved", paths);
				// debug("body: ", d);
				def.resolve(d);
			});
		}
	});
	return def.promise;
}

function readWorkspaceExperiments(tgState, options){

	const wsExpIds = tgState['wsExpIds'];
	const wsComparisonIds = tgState['wsComparisonIds'];
	const def = new Deferred();

    const expressionFiles =  wsExpIds.map(function(exp_id){
        var parts = exp_id.split('/'),
        jobName = parts.pop(),
        dotPath = parts.join('/') + '/.' + jobName +"/expression.json";
        return dotPath;
    });


		// debug("expressionFiles: ", expressionFiles);

		when(getWorkspaceObjects(expressionFiles, false, options.token), function(results){

			const p3FeatureIdSet = {};
			const p2FeatureIdSet = {};

			const expressions = results.map(function(d){

				// debug("expressionFile results", typeof d.data, wsComparisonIds);
				// debug(d.data);

				if(!wsComparisonIds){
					return JSON.parse(d.data)['expression'];
				}else{
					return JSON.parse(d.data)['expression'].filter(function(e){
						return wsComparisonIds.indexOf(e.pid) >= 0;
					});
				}
			});

			const flattened = [].concat.apply([], expressions);

			// debug("expressions: ", typeof flattened, flattened.length);

			flattened.forEach(function(expression){
				// debug("expression: ", typeof expression, expression.feature_id, expression.na_feature_id);
				if(expression.hasOwnProperty('feature_id')){
					if(!p3FeatureIdSet.hasOwnProperty(expression.feature_id)){
						p3FeatureIdSet[expression.feature_id] = true;
					}
				}else if(expression.hasOwnProperty('na_feature_id')){
					if(!p2FeatureIdSet.hasOwnProperty(expression.na_feature_id)){
						p2FeatureIdSet[expression.na_feature_id] = true;
					}
				}
			});

			// debug("expressions:", flattened.length, "p3 ids: ", Object.keys(p3FeatureIdSet).length, "p2 ids: ", Object.keys(p2FeatureIdSet).length);

			def.resolve({
				expressions: flattened,
				p3FeatureIds: Object.keys(p3FeatureIdSet),
				p2FeatureIds: Object.keys(p2FeatureIdSet)
			});
		});

	return def.promise;
}

function readPublicExperiments(tgState, options){

	const def = new Deferred();

	request.post({
		url: distributeURL + 'transcriptomics_gene/',
		json: true,
		headers: {
			'Accept': "application/solr+json",
			'Content-Type': "application/rqlquery+x-www-form-urlencoded",
			'Authorization': options.token || ""
		},
		body: tgState.query + "&select(pid,refseq_locus_tag,feature_id,log_ratio,z_score)&limit(1)"
	}, function(error, res, response){

		if(error || res.statusCode !== 200){
			debug(error, res.statusCode)
		}

		const numFound = response.response.numFound;

		const fetchSize = 25000;
		const steps = Math.ceil(numFound / fetchSize);
		const allRequests = [];

		for(let i = 0; i < steps; i++){
			const deferred = new Deferred();
			const range = "items=" + (i * fetchSize) + '-' + ((i + 1) * fetchSize - 1);
			// debug("Range: ", range);

			request.post({
				url: distributeURL + 'transcriptomics_gene/',
				json: true,
				headers: {
					'Accept': "application/json",
					'Content-Type': "application/rqlquery+x-www-form-urlencoded",
					'Range': range,
					'Authorization': options.token || ""
				},
				body: tgState.query + "&select(pid,refseq_locus_tag,feature_id,log_ratio,z_score)"
			}, function(err, res, body){
				deferred.resolve(body);
			});
			allRequests.push(deferred);
		}

		all(allRequests).then(function(results){

			const expressions = [];
			const p3FeatureIdSet = {};
			// const p2FeatureIdSet = {};

			results.forEach(function(genes){

				// debug("genes count: ", genes.length);

				genes.forEach(function(gene){
					expressions.push(gene);

					if(gene.hasOwnProperty("feature_id")){
						if(!p3FeatureIdSet.hasOwnProperty(gene.feature_id)){
							p3FeatureIdSet[gene.feature_id] = true;
						}
						// }else if(gene.hasOwnProperty("na_feature_id")){
						// 	if(!p2FeatureIdSet.hasOwnProperty(gene.na_feature_id)){
						// 		p2FeatureIdSet[gene.na_feature_id] = true;
						// 	}
					}
				});
			});

			// debug("expressions:", expressions.length, "p3 ids: ", Object.keys(p3FeatureIdSet).length, "p2 ids: ", Object.keys(p2FeatureIdSet).length);

			def.resolve({expressions: expressions, p3FeatureIds: Object.keys(p3FeatureIdSet), p2FeatureIds: []});
		});
	});

	return def.promise;
}

function processTranscriptomicsGene(tgState, options){
	const def = new Deferred();

	let wsCall = new Deferred();
	if(tgState.hasOwnProperty('wsExpIds')){
		wsCall = readWorkspaceExperiments(tgState, options);
	}else{
		wsCall.resolve({expressions: [], p3FeatureIds: [], p2FeatureIds: []});
	}

	let publicCall = new Deferred();
	if(tgState.hasOwnProperty('pbExpIds')){
		publicCall = readPublicExperiments(tgState, options);
	}else{
		publicCall.resolve({expressions: [], p3FeatureIds: [], p2FeatureIds: []});
	}

	all(publicCall, wsCall).then(function(results){
		// all(publicCall).then(function(results){

		const comparisonIdList = tgState.comparisonIds;

		const wsP3FeatureIdList = results[1].p3FeatureIds;
		const wsP2FeatureIdList = results[1].p2FeatureIds;
		const wsExpressions = results[1].expressions;

		const pbP3FeatureIdList = results[0].p3FeatureIds;
		const pbP2FeatureIdList = results[0].p2FeatureIds; // []
		const pbExpressions = results[0].expressions;

		const p3FeatureIdList = wsP3FeatureIdList.concat(pbP3FeatureIdList);
		const p2FeatureIdList = wsP2FeatureIdList.concat(pbP2FeatureIdList);
		const expressions = wsExpressions.concat(pbExpressions);

		debug("p3 ids: ", p3FeatureIdList.length, "p2 ids: ", p2FeatureIdList.length);

		const query = {
			q: [(p3FeatureIdList.length > 0) ? 'feature_id:(' + p3FeatureIdList.join(' OR ') + ')' : '',
				(p3FeatureIdList.length > 0 && p2FeatureIdList.length > 0) ? ' OR ' : '',
				(p2FeatureIdList.length > 0) ? 'p2_feature_id:(' + p2FeatureIdList.join(' OR ') + ')' : ''].join(''),
			fl: 'feature_id,p2_feature_id,strand,product,accession,start,end,patric_id,refseq_locus_tag,alt_locus_tag,genome_name,genome_id,gene'
		};
		// debug("genome_feature query: ", query);
		const q = Object.keys(query).map(p => p + "=" + query[p]).join("&");

		const fetchSize = 25000;
		const steps = Math.ceil((p3FeatureIdList.length + p2FeatureIdList.length) / fetchSize);
		const allRequests = [];

		for(let i = 0; i < steps; i++){
			const subDef = Deferred();
			const range = "items=" + (i * fetchSize) + '-' + ((i + 1) * fetchSize - 1);
			// debug("Range: ", range);

			request.post({
				url: distributeURL + 'genome_feature/',
				json: true,
				headers: {
					'Accept': "application/json",
					'Content-Type': "application/solrquery+x-www-form-urlencoded",
					'Range': range,
					'Authorization': options.token || ''
				},
				body: q
			}, function(err, res, body){
				subDef.resolve(body);
			});
			allRequests.push(subDef);
		}

		all(allRequests).then(function(body){

			const features = [].concat.apply([], body);

			const expressionHash = {};

			expressions.forEach(function(expression){
				let featureId;
				if(expression.hasOwnProperty("feature_id")){
					featureId = expression.feature_id;
				}else if(expression.hasOwnProperty("na_feature_id")){
					featureId = expression.na_feature_id;
				}

				if(!expressionHash.hasOwnProperty(featureId)){

					var expr = {samples: {}};
					(expression.hasOwnProperty('feature_id')) ? expr.feature_id = expression.feature_id : '';
					(expression.hasOwnProperty('na_feature_id')) ? expr.p2_feature_id = expression.na_feature_id : '';
					(expression.hasOwnProperty('refseq_locus_tag')) ? expr.refseq_locus_tag = expression.refseq_locus_tag : '';
					var log_ratio = expression.log_ratio, z_score = expression.z_score;
					expr.samples[expression.pid.toString()] = {
						log_ratio: log_ratio || '',
						z_score: z_score || ''
					};
					expr.up = (log_ratio != null && Number(log_ratio) > 0) ? 1 : 0;
					expr.down = (log_ratio != null && Number(log_ratio) < 0) ? 1 : 0;

					expressionHash[featureId] = expr;
				}else{
					expr = expressionHash[featureId];
					if(!expr.samples.hasOwnProperty(expression.pid.toString())){
						log_ratio = expression.log_ratio;
						z_score = expression.z_score;
						expr.samples[expression.pid.toString()] = {
							log_ratio: log_ratio || '',
							z_score: z_score || ''
						};
						(log_ratio != null && Number(log_ratio) > 0) ? expr.up++ : '';
						(log_ratio != null && Number(log_ratio) < 0) ? expr.down++ : '';

						expressionHash[featureId] = expr;
					}
				}
			});

			const data = [];
			features.forEach(function(feature){

				let expr;
				if(expressionHash.hasOwnProperty(feature.feature_id)){
					expr = expressionHash[feature.feature_id];
				}else if(expressionHash.hasOwnProperty(feature.p2_feature_id)){
					expr = expressionHash[feature.p2_feature_id];
				}
                if(expr){
                    // build expr object
                    let count = 0;
                    expr.sample_binary = comparisonIdList.map(function(comparisonId){
                        if(expr.samples.hasOwnProperty(comparisonId) && expr.samples[comparisonId].log_ratio !== ''){
                            count++;
                            return "1";
                        }else{
                            return "0";
                        }
                    }).join('');
                    expr.sample_size = count;

                    const datum = Object.assign(feature, expr);
                    data.push(datum);
                }
			});

			def.resolve(data);
		});
	});

	return def.promise;
}

module.exports = {
	requireAuthentication: false,
	validate: function(params){
		const tgState = params[0];
		return tgState && tgState.comparisonIds.length > 0;
	},
	execute: function(params){
		const def = new Deferred();

		const tgState = params[0];
		const opts = params[1];

		when(processTranscriptomicsGene(tgState, opts), function(result){
			def.resolve(result);
		}, function(err){
			def.reject("Unable to process protein family queries. " + err);
		});

		return def.promise;
	}
};
