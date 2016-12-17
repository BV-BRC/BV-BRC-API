const Deferred = require("promised-io/promise").Deferred;
const when = require('promised-io/promise').when;
const debug = require('debug')('p3api-server:ProteinFamily');
const request = require('request');
const config = require("../config");
const distributeURL = config.get("distributeURL");
const SOLR_URL = config.get("solr").url;
const solrjs = require('solrjs');

function processProteinFamily(pfState, options){
	const def = new Deferred();

	// moved from MemoryStore implementation.
	const familyType = pfState['familyType'];
	const familyId = familyType + '_id';

	const query = {
		q: "genome_id:(" + pfState.genomeIds.join(' OR ') + ")",
		fq: "annotation:PATRIC AND feature_type:CDS AND " + familyId + ":[* TO *]",
		rows: 0,
		facet: true,
		'facet.method': 'fc',
		'json.facet': '{stat:{type:field,field:' + familyId + ',sort:index,limit:-1,facet:{aa_length_min:"min(aa_length)",aa_length_max:"max(aa_length)",aa_length_mean:"avg(aa_length)",ss:"sumsq(aa_length)",sum:"sum(aa_length)"}}}'
	};
	const q = Object.keys(query).map(p => p + "=" + query[p]).join("&");

	request.post({
		url: distributeURL + 'genome_feature/',
		headers: {
			'Accept': "application/solr+json",
			'Content-Type': "application/solrquery+x-www-form-urlencoded",
			'Authorization': options.token || ""
		},
		json: true,
		body: q
	}, function(error, res, response){

		if(error){
			return def.reject(error);
		}

		if(response.facets.count == 0){
			// data is not available
			return def.resolve([]);
		}
		const familyStat = response.facets.stat.buckets;

		const familyIdList = [];
		familyStat.filter(el => el.val != "").forEach(el => familyIdList.push(el.val));

		// sub query - genome distribution
		query['json.facet'] = '{stat:{type:field,field:genome_id,limit:-1,facet:{families:{type:field,field:' + familyId + ',limit:-1,sort:{index:asc}}}}}';
		const sq = Object.keys(query).map(p => p + "=" + query[p]).join("&");

		// console.log("Do Second Request to /genome_feature/");
		request.post({
			url: distributeURL + 'genome_feature/',
			headers: {
				'Accept': "application/solr+json",
				'Content-Type': "application/solrquery+x-www-form-urlencoded",
				'Authorization': options.token || ""
			},
			json: true,
			body: sq
		}, function(error, resp, sub_response){

			if(error){
				return def.reject(error);
			}

			// request.post({
			// 	url: distributeURL + 'protein_family_ref/',
			// 	headers: {
			// 		'Accept': "application/json",
			// 		'Content-Type': "application/solrquery+x-www-form-urlencoded",
			// 		'Authorization': options.token || ""
			// 	},
			// 	body: 'q=family_type:' + familyType + ' AND family_id:(' + familyIdList.join(' OR ') + ')&rows=' + familyIdList.length
			// }, function(error, resp, body){
			debug("querying protein_family_ref: ", familyIdList.length);
			const query = 'q=family_type:' + familyType + ' AND family_id:(' + familyIdList.join(' OR ') + ')&rows=' + familyIdList.length + '&sort=family_id+asc';
			const solr = new solrjs(SOLR_URL + '/protein_family_ref');
			when(solr.stream(query), function(results){

				const res = [];
				results.stream.on('data', function(data){
					res.push(data);
				}).on('end', function(){

					debug("q3 body: ", res.length);
					const genomeFamilyDist = sub_response.facets.stat.buckets;
					const familyGenomeCount = {};
					const familyGenomeIdCountMap = {};
					const familyGenomeIdSet = {};
					const genomePosMap = {};
					const genome_ids = pfState.genomeIds;
					genome_ids.forEach((genomeId, idx) => genomePosMap[genomeId] = idx);

					genomeFamilyDist.forEach((genome) =>{
						const genomeId = genome.val;
						const genomePos = genomePosMap[genomeId];
						const familyBuckets = genome.families.buckets;

						familyBuckets.filter(bucket => bucket.val != "").forEach((bucket) =>{
							const familyId = bucket.val;

							let genomeCount = bucket.count.toString(16);
							if(genomeCount.length < 2) genomeCount = '0' + genomeCount;

							if(familyId in familyGenomeIdCountMap){
								familyGenomeIdCountMap[familyId][genomePos] = genomeCount;
							}
							else{
								const genomeIdCount = new Array(genome_ids.length).fill('00');
								genomeIdCount[genomePos] = genomeCount;
								familyGenomeIdCountMap[familyId] = genomeIdCount;
							}

							if(familyId in familyGenomeIdSet){
								familyGenomeIdSet[familyId].push(genomeId);
							}
							else{
								const genomeIds = new Array(genome_ids.length);
								genomeIds.push(genomeId);
								familyGenomeIdSet[familyId] = genomeIds;
							}
						});
					});

					Object.keys(familyGenomeIdCountMap).forEach(familyId =>{
						const hashSet = {};
						familyGenomeIdSet[familyId].forEach(function(value){
							hashSet[value] = true;
						});
						familyGenomeCount[familyId] = Object.keys(hashSet).length;
					});

					const familyRefHash = {};
					res.forEach(function(el){
						if(!(el.family_id in familyRefHash)){
							familyRefHash[el.family_id] = el.family_product;
						}
					});

					const data = [];
					familyStat.filter(el => el.val != "").forEach(el =>{
						const familyId = el.val;
						const featureCount = el.count;
						let std = 0;
						if(featureCount > 1){
							const sumSq = el.ss || 0;
							const sum = el.sum || 0;
							const realSq = sumSq - (sum * sum) / featureCount;
							std = Math.sqrt(realSq / (featureCount - 1));
						}

						const row = {
							family_id: familyId,
							feature_count: featureCount,
							genome_count: familyGenomeCount[familyId],
							aa_length_std: std,
							aa_length_max: el.aa_length_max,
							aa_length_mean: el.aa_length_mean,
							aa_length_min: el.aa_length_min,
							description: familyRefHash[familyId],
							genomes: familyGenomeIdCountMap[familyId].join("")
						};
						data.push(row);
					});

					def.resolve(data);
				});
			}, function(error){
				if(error){
					return def.reject(error);
				}
			});
		});
	});

	return def.promise;
}

module.exports = {
	requireAuthentication: false,
	validate: function(params){
		const pfState = params[0];
		return pfState && pfState.genomeIds.length > 0;
	},
	execute: function(params){
		const def = new Deferred();

		const pfState = params[0];
		const opts = params[1];

		when(processProteinFamily(pfState, opts), function(result){
			def.resolve(result);
		}, function(err){
			def.reject("Unable to process protein family queries. " + err);
		});

		return def.promise;
	}
};