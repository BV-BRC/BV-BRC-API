/**
 * This is a taxonomy model for the Wiki example application
 */
var Restrictive = require("dme/RestrictiveFacet");
var util = require("util");
var declare = require("dojo-declare/declare");
var when = require("promised-io/promise").when;
var defer= require("promised-io/promise").defer;

module.exports = declare([Restrictive], {
	query: function(query /*string*/,opts /*object*/ /*exposed*/){
		query += "?or(";
		query += [ 
			"eq(public,true)",
		 	"eq(ownerId," + opts.req.user.id + ")"
		].join(",")
		query += ")"
		return this.model.query(query,opts);	
	},

	get: function(id /*string*/, opts /*object*/ /*exposed*/){
		return when(this.model.get(id,opts), function(obj){
			if (!obj.public || (obj.ownerId == opts.req.user.id)){
				throw new Error("Not Allowed");	
			}
			return obj;
		});
	},

	properties: "*"
});

