const Deferred = require("promised-io/promise").Deferred;
const when = require('promised-io/promise').when;
const debug = require('debug')('p3api-server:ProteinFamily');
const request = require('request');
const config = require('../config');
const distributeURL = config.get('distributeURL');
const redisOptions = config.get('redis');
const redis = require("redis");
const redisClient = redis.createClient(redisOptions);
const RedisTTL = 60*60*24; // sec
const currentContext = 5;
const all = require('promised-io/promise').all;

function fetchFamilyDescriptionBatch(familyIdList){
	const def = Deferred()
	const familyRefHash = {}

	redisClient.mget(familyIdList, function(err, replies){

		const missingIds = []
		replies.forEach((reply, i) => {
			if (reply == null) {
				missingIds.push( familyIdList[i] )
			} else {
				familyRefHash[familyIdList[i]] = reply
			}
		})

		if (missingIds.length == 0){
			def.resolve(familyRefHash)
		} 
		else {
			request.post({
				url: distributeURL + 'protein_family_ref/',
				json: true,
				headers: {
						'Accept': "application/json",
						'Content-Type': "application/solrquery+x-www-form-urlencoded",
						'Authorization': ""
				},
				body: 'q=family_id:(' + missingIds.join(' OR ') + ')&fl=family_id,family_product&rows=' + missingIds.length
			}, function(error, resp, body){
				if(error){
					def.reject(error);
				}

				body.forEach(family => {
					redisClient.set(family.family_id, family.family_product)
					familyRefHash[family.family_id] = family.family_product
				})

				def.resolve(familyRefHash)
			})
		}
	})

	return def.promise
}

function fetchFamilyDescriptions(familyIdList){
	const def = Deferred()
	const fetchSize = 3000
	const steps = Math.ceil(familyIdList.length / fetchSize)
	const allRequests = []
	const qSt = Date.now()

	for(let i = 0; i < steps; i++){
		const subDef = Deferred();
		const subFamilyIdList = familyIdList.slice(i * fetchSize, Math.min((i + 1) * fetchSize, familyIdList.length));

		allRequests.push( fetchFamilyDescriptionBatch(subFamilyIdList) )
	}

	debug("protein_family_ref checking cache took", (Date.now() - qSt) / 1000, "s")

	all(allRequests).then(body => {
		debug("protein_family_ref took", (Date.now() - qSt) / 1000, "s")

		const familyRefHash = body.reduce((r, b) => {
				return Object.assign(r,b);
		}, {})

		def.resolve(familyRefHash);
	})

	return def.promise
}

function fetchFamilyDataByGenomeId(genomeId, options){
	const def = Deferred()
	const key = 'pfs_' + genomeId

	redisClient.get(key, function(err, familyData) {

		if (familyData == null) {

			debug(`no cached data for ${key}`)

			const query = `?q=genome_id:${genomeId} AND annotation:PATRIC AND feature_type:CDS&rows=25000&fl=pgfam_id,plfam_id,figfam_id,aa_length`

			request.get({
				url: distributeURL + 'genome_feature/' + query,
				headers: {
					'Accept': "application/json",
					'Content-Type': "application/solrquery+x-www-form-urlencoded",
					'Authorization': options.token || ""
				},
				json: true
			}, function(error, resp, body){
				if(error){
					def.reject(error);
				}
				if (typeof body == "object") {
					redisClient.set(key, JSON.stringify(body), 'EX', RedisTTL);
					def.resolve(body);
				} else {
					def.reject(body)
				}
			});
		} else {
			redisClient.expire(key, RedisTTL)
			def.resolve(JSON.parse(familyData));
		}
	})

	return def.promise
}

function fetchFamilyData(familyType, genomeIdList, options){
	const def = Deferred();
	const allRequests = [];
	const familyIdField = familyType + '_id';

	const qSt = Date.now();
	genomeIdList.forEach(genomeId => {
		allRequests.push(fetchFamilyDataByGenomeId(genomeId, options));
	})

	all(allRequests).then(body => {

		debug("fetching family data took ", (Date.now() - qSt) / 1000, "s");

		const totalFamilyIdDict = {};

		body.forEach((data, i) => {
			const genomeId = genomeIdList[i];
			
			data.forEach(row => {
				const fid = row[familyIdField]
				if (fid === "" || fid === undefined) return;

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

		def.resolve(totalFamilyIdDict)
	});

	return def.promise
}

function processProteinFamily(pfState, options){
	const def = new Deferred();

	// moved from MemoryStore implementation.
	const familyType = pfState['familyType'];
	const genomeIds = pfState.genomeIds;

	when(fetchFamilyData(familyType, genomeIds, options), function(totalFamilyIdDict){

		// debug(totalFamilyIdDict)
		const familyIdList = Object.keys(totalFamilyIdDict);

		when(fetchFamilyDescriptions(familyIdList), function(familyRefHash){

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