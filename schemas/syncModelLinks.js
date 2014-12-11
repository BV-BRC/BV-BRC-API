var parseArgs = require('minimist');
var when = require("promised-io/promise").when;
var argv = parseArgs(process.argv,{});
var fs = require("fs-extra");

if (argv.v){ argv.verbose=true;}

var verbose = function(){
	if (argv.verbose){
		console.log.apply(console,arguments);
	}
}

verbose("Arguments ", argv);

if (argv.n){
	argv.name = argv.n;
}

if (!argv.name){
	throw new Error("Please supply a name (-n {name}) that references the local json model file you want to sync");
}

if (!argv.update){
	verbose("Updates will only be printed to the console, use the --update parameter to output to {name}.json");
}

var name = argv.name 

var newLinks = [{
		"rel": "self",
		"title": "Get a "+ name + " instance",
		"method": "GET",
		"template": "default",
		"href": "/" + name + "/{id}",
		"targetSchema": {
			"$ref": "#"
		}
	}, {
		"rel": "query",
		"title": "Query "+ name +" instances.",
		"method": "GET",
		"href":  "/" + name + "/",
		"template": "default-list",
		"targetSchema": {
			"type": "array",
			"items": {
				"$ref": "#"
			}
		}
	},

	{
		"rel": "create",
		"title": "Create " + name + "(s).  Throw error if " + name + " already exists.",
		"encType": "application/json",
		"method": "POST",
		"href": "/" + name + "/",
		"schema": {
			"oneOf": [{
				"$ref": "#"
			}, {
				"type": "array",
				"items": {
					"$ref": "#"
				}
			}]
		},
		"targetSchema": {
			"type": "array",
			"items": {
				"oneOf": [{
					"$ref": "#"
				}, {
					"type": "array",
					"items": {
						"$ref": "#"
					}
				}]
			}
		}
	},

	{
		"rel": "update",
		"title": "Update "+ name + ". Partial Update OK. Throw error if "+ name +" does not exist",
		"encType": "application/json",
		"method": "POST",
		"href": "/" + name + "/{id}",
		"schema": {
			"$ref": "#"
		},
		"targetSchema": {
			"$ref": "#"
		}
	},

	{
		"rel": "create",
		"title": "Create "+ name + ". Overwrite it if it already exists.",
		"encType": "application/json",
		"method": "PUT",
		"href": "/" + name + "/{id}",
		"schema": {
			"$ref": "#"
		},
		"targetSchema": {
			"type": "null"
		}
	},

	{
		"rel": "delete",
		"title": "Delete a "+ name,
		"method": "DELETE",
		"href": "/" + name + "/{id}",
		"targetSchema": {
			"type": "null"
		}
	},{
		"rel": "rpc",
		"title": "JSON-RPC Endpoint for the " + name + " Model.  Parameters and Response schema as per the associated link relation.",
		"encType": "application/jsonrpc+json",
		"mediaType": "application/jsonrpc+json",
		"method": "POST",
		"href":  "/" + name
	},{
		"rel": "describedBy",
		"title": name + " Schema",
		"encType": "application/schema+json",
		"mediaType": "application/schema+json",
		"method": "GET",
		"href":  "/" + name + "/"
	}
];

fs.readJSON("./" + name + ".json", function(err,schema){
	if (err){
		console.error(err);
		return err;
	}

	schema.pathStart = "/" + name + "/";
	// verbose("New Schema", schema)
	schema.links = newLinks;

	if (argv.verbose || !argv.update){
		console.log(JSON.stringify(schema,null,4));
	}

	if (argv.update){
		fs.writeJSON("./" + name + ".json",schema, function(err){
			if (err){
				console.error("Error updating schema file: ", name, err);
			}else{
				verbose(name + ".json Updated.");
			}
		})
	}
});
