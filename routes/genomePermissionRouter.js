/**
 * genomePermissionRouter
 *
 * Creates endpoint for editing genome permissions (and all associated cores)
 *
 *
 * Todo: ensure request is completely correct
 *
 */
const express = require('express');
const router = express.Router({strict: true, mergeParams: true});

const PublicDataTypes = require("../middleware/PublicDataTypes");
const authMiddleware = require("../middleware/auth");
const httpParams = require("../middleware/http-params");
const bodyParser = require("body-parser");

const debug = require('debug')('p3api-server:genomePermissions');
const conf = require("../config");
const when = require("promised-io/promise").when;
const defer = require("promised-io/promise").defer;

const solrjs = require("solrjs");
const SOLR_URL = conf.get("solr").url;
const request = require('request-promise');


const genomeCoresUUIDs = {
	genome: 'genome_id',
	genome_sequence: 'sequence_id',
	genome_feature: 'feature_id',
	pathway: 'id',
	sp_gene: 'id',
	genome_amr: 'id'
}

router.use(httpParams);
router.use(authMiddleware);
router.use(PublicDataTypes);

router.post("/:target_id", [
	bodyParser.json({type: ["application/json"], limit: "100mb"}),
	updatePermissions
])


// example request used for help messages
const exampleRequest = [{
	user: "user1@patricbrc.org",
	permission: 'read'
}, {
	user: "user2@patricbrc.org",
	permission: 'write'
}]


function updatePermissions(req, res, next){
	if (!req._body || !req.body) {
		console.log('no body')
		return next();
	}

	const collection = "genome";
	const permissions = req.body;
	const genomeIDs = req.params.target_id.split(',');

	// ensure parameters are correct, or respond with appropriate message
	const hasPassed = testParams(req, res, permissions);
	if (!hasPassed) return;

	let proms = [];
	genomeIDs.forEach(genomeID => {
		debug(`genomeID: ${genomeID}`)

		// update objects from all genome-related cores
		Object.keys(genomeCoresUUIDs).forEach(core =>{
			debug(`updating core ${core}...`)

			const solr = new solrjs(SOLR_URL + "/" + core);

			// for each core, fetch objects keys and owners
			// Notes:
			//	-  keys are needed to update objects
			//	-  owner is needed to check permission
			let key = genomeCoresUUIDs[core]
			let query = `q=genome_id:${genomeID}&fl=${key},owner&rows=100000`
			var prom = solr.query(query)
				.then(r => {
					debug(`retrieved records for genome ${genomeID} (core: ${core})...`)

					// get onlyactual records
					var records = r.response.docs;

					// skip empty records
					if (records.length == 0) {
						debug(`skipping empty records for core/genome: ${core}/${genomeID}`)
						return;
					}

					// create a command for each record
					let commands = [];
					records.forEach(record => {
						if (!(record.owner == req.user) ) {
							debug("User forbidden from private data");
							res.status(403).end();
						}

						commands.push(
							toSetCommand(record, record[key], permissions, core)
						)
					})

					return updateSOLR(commands, core)

				}, err => {
					console.log("Error retrieving " + collection  + " with id " + target_id);
					res.status(406).send("Error retrieving target");
					res.end();
				});

			proms.push(prom);
		})
	})

	Promise.all(proms)
		.then(r => {
			debug('success.')
			res.sendStatus(200);
		}).catch(err => {
			debug('FAILED', err)
			res.status(406).send("Error updating document" + err);
		})
}


function testParams(req, res, patch) {
	if (!req.user) {
		res.status(401).send("User not logged in, permission denied.");
		return;
	} else if (!req.params.target_id) {
		res.status(400).send(
			"Request must must contain genome id(s). I.e., /permissions/genome/9999.9999"
		);
		return;
	}

	return true;
}


function toSetCommand(record, id, patch, core) {
	let readUsers = patch
		.filter(p => p.permission == 'read')
		.map(p => {
			if (p.permission == 'read') return p.user;
		});

	let writeUsers = patch
		.filter(p => p.permission == 'write')
		.map(p => {
			if (p.permission == 'write') return p.user;
		});

	let cmd = {};
	cmd[genomeCoresUUIDs[core]] = id;

	cmd.user_read = {set: readUsers};
	cmd.user_write = {set: writeUsers};

	return cmd;
}


function updateSOLR(commands, core){
	let url = SOLR_URL+ `/${core}/update?wt=json&softCommit=true`;

	return request(url, {
		json: true,
		method: "POST",
		headers: {
			"content-type": "application/json",
			"accept":"application/json"
		},
		body: commands
	})
}

module.exports = router;