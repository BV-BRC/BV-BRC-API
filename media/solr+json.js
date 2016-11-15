var debug = require("debug")("p3api-server:media/solr+json");

module.exports = {
	contentType: "application/solr+json",
	serialize: function(req, res, next){
		res.send(JSON.stringify(res.results));
		res.end();
	}
};
