/**
 * This is a taxonomy model for the Wiki example application
 */
var ModelBase = require("dme/Model").Model;
var util = require("util");
var declare = require("dojo-declare/declare");
var when = require("promised-io/promise").when;

var Model = exports.Model = declare([ModelBase], {
	maxLimit: 200,
	defaultLimit: 25,
	primaryKey: "figfam_id",
	schema: { 
		"$schema": "http://json-schema.org/draft-04/schema#",
		"description": "Workspace Schema",
		type: "object"
	}
});

