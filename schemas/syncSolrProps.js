var SOLRStore = require("dme/store/solr")
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

if (!argv.solr){
	throw new Error("Please add the --solr http://solr.server/solr option to the command line");
}
if (!argv.name){
	throw new Error("Please supply a name (-n {name}) that references the local json model file you want to sync");
}

if (!argv.update){
	verbose("Updates will only be printed to the console, use the --update parameter to output to {name}.json");
}


var name = argv.name;

var solrStore = new SOLRStore(name,{url: argv.solr});

verbose("Retrieving schema from SOLR: ", argv.solr);
var solrSchema =  solrStore.getSchema();

when(solrSchema, function(solrSchema){
	verbose("Got Schema, read schema from: ", "./"+name+".json");
	fs.readJSON("./" + name + ".json", function(err,schema){
		if (err){
			console.error(err);
			return err;
		}
		for (prop in solrSchema){
			schema[prop]=solrSchema[prop];
		}
		schema.pathStart = "/" + name;
		// verbose("New Schema", schema)
	
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
	})

	// verbose("Solr Schema", solrSchema);
})
