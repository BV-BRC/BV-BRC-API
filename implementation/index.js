var fs = require("fs-extra");
var debug = require("debug")("p3api-server");
var path = require("path");

var implementations = {};

module.exports = function(){
	debug("Loading Implementation Files from: ", __dirname);
	fs.readdirSync(__dirname).filter(function(filename){ return filename.match(".js") && (filename != "index.js") }).forEach(function(filename){
		var name = filename.replace(".js","");
		debug("Loading Implementation" + name + " from " + filename);
		implementations[name]=require(path.join(__dirname,name));
	})
	return implementations;
}();
