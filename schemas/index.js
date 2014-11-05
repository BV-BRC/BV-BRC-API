var fs = require("fs-extra");
var debug = require("debug")("p3api-server");
var path = require("path");

var schemas = {};

module.exports = function(){
	fs.readdirSync(__dirname).filter(function(filename){ return filename.match(".json") }).forEach(function(filename){
		debug("Loading Scema file: ", filename);

		var name = filename.replace(".json","");
		schemas[name]=fs.readJsonSync(path.join(__dirname,filename));
	})
	return schemas;
}();
