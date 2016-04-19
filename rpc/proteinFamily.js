var defer = require("promised-io/promise").defer;
var when = require('promised-io/promise').when;
var debug = require('debug')('p3api-server:ProteinFamily');
var request = require('request');

function processProteinFamily(pfState, options){
	var def = new defer();

	// moved from MemoryStore implementation.
	var familyType = pfState['familyType'];
	var familyId = familyType + '_id';

	var query = {
		q: "genome_id:(" + pfState.genomeIds.join(' OR ') + ")",
		fq: "annotation:PATRIC AND feature_type:CDS AND " + familyId + ":[* TO *]",
		rows: 0,
		facet: true,
		'facet.method': 'uif',
		'json.facet': '{stat:{type:field,field:' + familyId + ',sort:index,limit:-1,facet:{aa_length_min:"min(aa_length)",aa_length_max:"max(aa_length)",aa_length_mean:"avg(aa_length)",ss:"sumsq(aa_length)",sum:"sum(aa_length)"}}}'
	};
	var q = Object.keys(query).map(function(p){
		return p + "=" + query[p]
	}).join("&");

	request.post({
		url: options.apiServer + '/genome_feature/',
		headers: {
			'Accept': "application/solr+json",
			'Content-Type': "application/solrquery+x-www-form-urlencoded",
			'X-Requested-With': null,
			'Authorization': options.token || ""
		},
		body: q
	}, function(error, res, body){

		if (error){
			return def.reject(error);
		}

		var response = JSON.parse(body);
		// debug("q1 response: ", typeof(response));

		if(response.facets.count == 0){
			// data is not available
			return def.reject("data is not available");
		}
		var familyStat = response.facets.stat.buckets;

		var familyIdList = [];
		familyStat.forEach(function(element){
			if(element.val != ""){
				familyIdList.push(element.val);
			}
		});

		// sub query - genome distribution
		query['json.facet'] = '{stat:{type:field,field:genome_id,limit:-1,facet:{families:{type:field,field:' + familyId + ',limit:-1,sort:{index:asc}}}}}';
		q = Object.keys(query).map(function(p){
			return p + "=" + query[p]
		}).join("&");

		// console.log("Do Second Request to /genome_feature/");
		request.post({
			url: options.apiServer + '/genome_feature/',
			headers: {
				'Accept': "application/solr+json",
				'Content-Type': "application/solrquery+x-www-form-urlencoded",
				'X-Requested-With': null,
				'Authorization': options.token || ""
			},
			body: q
		}, function(error, resp, body){

			if (error){
				return def.reject(error);
			}

			response = JSON.parse(body);
			// debug("q2 body: ", response);
			request.post({
				url: options.apiServer + '/protein_family_ref/',
				headers: {
					'Accept': "application/solr+json",
					'Content-Type': "application/solrquery+x-www-form-urlencoded",
					'X-Requested-With': null,
					'Authorization': options.token || ""
				},
				form: {
					q: 'family_type:' + familyType + ' AND family_id:(' + familyIdList.join(' OR ') + ')',
					rows: 1000000
				}
			}, function(error, resp, body){

				if (error){
					return def.reject(error);
				}

				var res = JSON.parse(body);
				// debug("q3 body: ", res);
				var genomeFamilyDist = response.facets.stat.buckets;
				var familyGenomeCount = {};
				var familyGenomeIdCountMap = {};
				var familyGenomeIdSet = {};
				var genomePosMap = {};
				var genome_ids = pfState.genomeIds;
				genome_ids.forEach(function(genomeId, idx){
					genomePosMap[genomeId] = idx;
				});

				genomeFamilyDist.forEach(function(genome){
					var genomeId = genome.val;
					var genomePos = genomePosMap[genomeId];
					var familyBuckets = genome.families.buckets;

					familyBuckets.forEach(function(bucket){
						var familyId = bucket.val;
						if(familyId != ""){
							var genomeCount = bucket.count.toString(16);
							if(genomeCount.length < 2) genomeCount = '0' + genomeCount;

							if(familyId in familyGenomeIdCountMap){
								familyGenomeIdCountMap[familyId][genomePos] = genomeCount;
							}
							else{
								var genomeIdCount = new Array(genome_ids.length).fill('00');
								genomeIdCount[genomePos] = genomeCount;
								familyGenomeIdCountMap[familyId] = genomeIdCount;
							}

							if(familyId in familyGenomeIdSet){
								familyGenomeIdSet[familyId].push(genomeId);
							}
							else{
								var genomeIds = new Array(genome_ids.length);
								genomeIds.push(genomeId);
								familyGenomeIdSet[familyId] = genomeIds;
							}
						}
					});
				});

				Object.keys(familyGenomeIdCountMap).forEach(function(familyId){
					var hashSet = {};
					familyGenomeIdSet[familyId].forEach(function(value){
						hashSet[value] = true;
					});
					familyGenomeCount[familyId] = Object.keys(hashSet).length;
				});

				var familyRefHash = {};
				res.response.docs.forEach(function(el){
					if(!(el.family_id in familyRefHash)){
						familyRefHash[el.family_id] = el.family_product;
					}
				});

				var data = [];
				familyStat.forEach(function(element){
					var familyId = element.val;
					if(familyId != ""){
						var featureCount = element.count;
						var std = 0;
						if(featureCount > 1){
							var sumSq = element.ss || 0;
							var sum = element.sum || 0;
							var realSq = sumSq - (sum * sum) / featureCount;
							std = Math.sqrt(realSq / (featureCount - 1));
						}

						var row = {
							family_id: familyId,
							feature_count: featureCount,
							genome_count: familyGenomeCount[familyId],
							aa_length_std: std,
							aa_length_max: element.aa_length_max,
							aa_length_mean: element.aa_length_mean,
							aa_length_min: element.aa_length_min,
							description: familyRefHash[familyId],
							genomes: familyGenomeIdCountMap[familyId].join("")
						};
						data.push(row);
					}
				});

				def.resolve(data);
			});
		});
	});

	return def.promise;
}

module.exports = {
	requireAuthentication: false,
	validate: function(params){
		var pfState = params[0];
		return pfState && pfState.genomeIds.length > 0;
	},
	execute: function(params){
		var def = new defer();

		var pfState = params[0];
		var opts = params[1];

		when(processProteinFamily(pfState, opts), function(result){
			def.resolve(result);
		}, function(err){
			def.reject("Unable to process protein family queries. " + err);
		});

		return def.promise;
	}
};