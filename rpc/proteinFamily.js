const Deferred = require("promised-io/promise").Deferred;
const when = require('promised-io/promise').when;
const debug = require('debug')('p3api-server:ProteinFamily');
const request = require('request');
const config = require("../config");
const distributeURL = config.get("distributeURL");
const all = require('promised-io/promise').all;

function fetchFamilyDescriptions(familyType, familyIdList){

	const def = Deferred();
	const fetchSize = 5000;
	const steps = Math.ceil(familyIdList.length / fetchSize);
	const allRequests = [];

	const q2St = Date.now();

	for(let i = 0; i < steps; i++){
		const subDef = Deferred();
		const subFamilyIdList = familyIdList.slice(i * fetchSize, Math.min((i + 1) * fetchSize, familyIdList.length));

		// debug("subFamilyList: ", subFamilyIdList.length, i*fetchSize, Math.min((i+1)*fetchSize, familyIdList.length));
		request.post({
			url: distributeURL + 'protein_family_ref/',
			json: true,
			headers: {
				'Accept': "application/json",
				'Content-Type': "application/solrquery+x-www-form-urlencoded",
				'Authorization': ""
			},
			body: 'q=family_type:' + familyType + ' AND family_id:(' + subFamilyIdList.join(' OR ') + ')&fl=family_id,family_product&rows=' + subFamilyIdList.length
		}, function(error, resp, body){
			if(error){
				subDef.reject(error);
			}
			subDef.resolve(body);
		});
		allRequests.push(subDef);
	}
	debug("querying protein_family_ref: ", familyIdList.length);

	all(allRequests).then(function(body){
		debug("protein_family_ref took", (Date.now() - q2St) / 1000, "s");

		const res = body.reduce((r, b) => {
			return r.concat(b);
		}, [])

		const familyRefHash = {};
		res.forEach(function(el){
			if(!familyRefHash.hasOwnProperty(el.family_id)){
				familyRefHash[el.family_id] = el.family_product;
			}
		});

		def.resolve(familyRefHash);
	});

	return def.promise;
}

function processProteinFamily(pfState, options){
	const def = new Deferred();

	// moved from MemoryStore implementation.
	const familyType = pfState['familyType'];
	const familyId = familyType + '_id';

	const genomeIds = pfState.genomeIds;
	const numGenomeIds = genomeIds.length;
	const allRequests = [];

	const qSt = Date.now();
	for(let i = 0; i < numGenomeIds; i++){
		const subDef = Deferred()

		const query = {
			q: "genome_id:" + genomeIds[i],
			fq: "annotation:PATRIC AND feature_type:CDS AND " + familyId + ":[* TO *]",
			rows: 25000,
			fl: familyId + ",aa_length"
		};

		request.post({
			url: distributeURL + 'genome_feature/',
			headers: {
				'Accept': "application/json",
				'Content-Type': "application/solrquery+x-www-form-urlencoded",
				'Authorization': options.token || ""
			},
			json: true,
			body: Object.keys(query).map(p => p + "=" + query[p]).join("&")
		}, function(error, resp, body){
			if(error){
				subDef.reject(error);
			}
			subDef.resolve(body);
		})
		allRequests.push(subDef);
	}

	debug("querying genome_feature: ", numGenomeIds);

	all(allRequests).then(function(body){

		debug("facet queries took ", (Date.now() - qSt) / 1000, "s");

		const totalFamilyIdDict = {};

		body.forEach((data, i) => {
			const genomeId = genomeIds[i];
			
			data.forEach(row => {
				const fid = row[familyId]
				if (fid === "") return;

				if (totalFamilyIdDict.hasOwnProperty(fid)){

					if (totalFamilyIdDict[fid].hasOwnProperty(genomeId)){
						totalFamilyIdDict[fid][genomeId].push(row['aa_length'])
					} else {
						// has fid, but not genome id
						totalFamilyIdDict[fid][genomeId] = [row['aa_length']]
					}

				} else {
					totalFamilyIdDict[fid] = {};
					totalFamilyIdDict[fid][genomeId] = [row['aa_length']];
				}
			})
		})

		// debug(totalFamilyIdDict)
		const familyIdList = Object.keys(totalFamilyIdDict);

		when(fetchFamilyDescriptions(familyType, familyIdList), function(familyRefHash){

			const qSt = Date.now();
			const data = [];
			familyIdList.sort().forEach(familyId => {

				const proteins = genomeIds.map(genomeId => {
					return totalFamilyIdDict[familyId][genomeId]
				})
				.filter(row => row !== undefined)
				.reduce((total, proteins) => {
					return total.concat(proteins)
				}, [])

				const aa_length_max = Math.max.apply(Math, proteins);
				const aa_length_min = Math.min.apply(Math, proteins);
				const aa_length_sum = proteins.reduce((total, val) => total + val, 0);
				const aa_length_mean = aa_length_sum / proteins.length;
				const aa_length_variance = proteins.map(val => Math.pow(val - aa_length_mean, 2))
					.reduce((total, val) => total + val, 0) / proteins.length;
				const aa_length_std = Math.sqrt(aa_length_variance);
				
				// debug(proteins, aa_length_mean, aa_length_variance, aa_length_std);

				const genomeString = genomeIds.map(genomeId => {
					if (totalFamilyIdDict[familyId].hasOwnProperty(genomeId)) {
						const count = totalFamilyIdDict[familyId][genomeId].length;
						if (count < 10){
							return '0' + count.toString(16);
						} else {
							return count.toString(16);
						}
					} else {
						return '00';
					}
				}).join('')

				const row = {
					family_id: familyId,
					feature_count: proteins.length,
					genome_count: Object.keys(totalFamilyIdDict[familyId]).length,
					aa_length_std: aa_length_std,
					aa_length_max: aa_length_max,
					aa_length_mean: aa_length_mean,
					aa_length_min: aa_length_min,
					description: familyRefHash[familyId],
					genomes: genomeString
				};
				data.push(row);
			});

			debug("processing protein family data took ", (Date.now() - qSt) / 1000, "s");

			def.resolve(data);
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