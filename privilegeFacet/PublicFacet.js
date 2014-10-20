/**
 * This is a taxonomy model for the Wiki example application
 */
var debug = require("debug")("p3api:facet:public");
var Restrictive = require("dme/RestrictiveFacet");
var util = require("util");
var declare = require("dojo-declare/declare");
var when = require("promised-io/promise").when;
var defer= require("promised-io/promise").defer;

module.exports = declare([Restrictive], {
	query: function(query /*string*/,opts /*object*/ /*exposed*/){
		query += "&eq(public,true)";
		debug("Public Facet Query: ", query);
		return this.model.query(query,opts);	
	},

	get: function(id /*string*/, opts /*object*/ /*exposed*/){
		return when(this.model.get(id,opts), function(obj){
			if (!obj.public){
				throw new Error("Not Allowed");	
			}
			return obj;
		});
	},

	properties: "*"
});

