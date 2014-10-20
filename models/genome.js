/**
 * This is a taxonomy model for the Wiki example application
 */
var ModelBase = require("dme/Model").Model;
var util = require("util");
var declare = require("dojo-declare/declare");
var when = require("promised-io/promise").when;
var defer= require("promised-io/promise").defer;

var Model = exports.Model = declare([ModelBase], {
	maxLimit: 200,
	defaultLimit: 25,
	primaryKey: "genome_id",
	schema: { 
		"description": "PATRIC 3 Genome Schema"
	},

	doSomething: function(foo /*string*/,bar /*bar*/ /*expose*/){

	}

});

