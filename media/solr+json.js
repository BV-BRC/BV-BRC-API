var debug = require("debug")("media");

module.exports = {
	contentType: "application/solr+json",
	serialize: function(req,res,next){
		res.send(JSON.stringify(res.results));
		res.end();
	}
}
