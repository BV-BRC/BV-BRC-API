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

const debug = require('debug')('p3api-server:cachemiddleware');
const conf = require("../config");
const when = require("promised-io/promise").when;
const defer = require("promised-io/promise").defer;

const solrjs = require("solrjs");
const SOLR_URL = conf.get("solr").url;
//const Request = require("request");
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
const exampleRequest = {
	op: 'add',
	users: 'me@patricbrc.org',
	permission: 'read'
}


function updatePermissions(req, res, next){
	if (!req._body || !req.body) {
		console.log('no body')
		return next();
	}

	const collection = "genome";
	const patch = req.body;
	const genomeIDs = req.params.target_id.split(',');

	// ensure parameters are correct, or respond with appropriate message
	const hasPassed = testParams(req, res, patch);
	if (!hasPassed) return;

	let proms = [];
	genomeIDs.forEach(genomeID => {
		console.log(`genomeID: ${genomeID}`)

		Object.keys(genomeCoresUUIDs).forEach(core =>{
			console.log(`updating core ${core}...`)

			const solr = new solrjs(SOLR_URL + "/" + core);

			let key = genomeCoresUUIDs[core]
			let query = `q=genome_id:${genomeID}&fl=${key},owner,user_read,user_write&rows=100000`

			var prom = solr.query(query)
				.then(r => {
					console.log(`retrieved records for genome ${genomeID} (core: ${core})...`)

					// get actual records
					var records = r.response.docs;
					if (records.length == 0) {
						console.log(`skipping empty records for core ${core}`)
						return;
					}

					// create a command for each record
					let commands = [];
					records.forEach(record => {

						if (!(record.owner == req.user) ||
							(record.user_write && !record.user_write.indcludes(req.user)) ) {
							console.log("FORBIDDEN")
							debug("User forbidden from private data");
							res.sendStatus(403);
						}

						commands.push(
							toCommand(record, record[key], patch.op, patch.permission, patch.users, core)
						)
					})

					return updateSOLR(commands, core)

				}, err => {
					console.log("Error retrieving " + collection  + " with id " + target_id);
					res.status(406).send("Error retrieving target");
					res.end();
				});

			proms.push(prom)
		})
	})

	Promise.all(proms)
		.then(r => {
			console.log('success.')
			res.sendStatus(201);
		}).catch(err => {
			console.log('FAILED', err)
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
	} else if (!patch.op){
		res.status(400).send(
			"Request must must contain an operation 'op'.\n" +
			"Example: " + JSON.stringify(exampleRequest, null, 4)
		);
		return;
	} else if (!patch.users) {
		res.status(400).send(
			"Request must must contain at least one user in 'users'.\n" +
			"Example: " + JSON.stringify(exampleRequest, null, 4)
		);
		return;
	} else if (!patch.permission) {
		res.status(400).send(
			"Request must must contain a permission 'permission'.\n" +
			"Example: " + JSON.stringify(exampleRequest, null, 4)
		);
		return;
	}

	return true;
}


function toCommand(record, id, op, perm, users, core) {
	var users = Array.isArray(users) ? users : [users]

	// join to existing permissions and remove duplicates
	if (op == 'add' && perm == 'read') {
		users = (record.user_read || []).concat(users)
		users = users.filter((x, i) =>  users.indexOf(x) === i );
	} else if (op == 'add' && perm == 'write') {
		users = (record.user_wrte || []).concat(users);
		users = users.filter((x, i) =>  users.indexOf(x) === i );
	} else if (op == 'remove' && perm == 'read') {
		users = (record.user_read || []).filter((x, i) => !users.includes(x) );
	} else if (op == 'remove' && perm == 'write') {
		users = (record.user_write || []).filter((x, i) => !users.includes(x) );
	}

	let cmd = {};
	cmd[genomeCoresUUIDs[core]] = id;

	if (perm == 'read')
		cmd.user_read = {"set": users}
	else if (perm == 'write')
		cmd.user_write = {"set": users}


	return cmd;
}


function updateSOLR(commands, core){
	console.log('updating core: ', core)
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