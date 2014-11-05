var RestrictiveFacet = require("dme/RestrictiveFacet");
var util = require("util");
var when = require("promised-io/promise").when;
var errors = require("dme/errors");

var Facet = module.exports = function(model,implementation){
	var internal = {get:true,query:true,properties:true,links:{includedRelations: ["self","query"]}};
	if (implementation){
		Object.keys(implementation).forEach(function(prop){ internal[prop]=implementation[prop]; });
	}

	implementation = internal;

	implementation.query = function(query,opts){
		var additions = [
			"eq(public,PUBLIC)",
			"eq(owner," + opts.req.user.id + ")"
		]
		query += "&or(" + additions.join(",") + ")" ; 
		
		return this.model.query(query,opts);
	}


	implementation.get = function(id,opts){
		return when(this.model.get(id,opts), function(results){
			if (results && results.results && results.results.public=="PUBLIC"){
				return results;
			}
			return errors.Unauthorized();
		});
	}


	RestrictiveFacet.apply(this,[model,implementation]);
}

util.inherits(Facet, RestrictiveFacet);
