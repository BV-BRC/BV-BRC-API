var debug = require('debug')('p3api-server:DecorateQuery');
var url = require("url");

module.exports = function(req, res, next) {
	if (req.call_method !="query"){ return next(); }

	req.call_params[0] = req.call_params[0] || "&q=*:*";

	var parsed = url.parse("?"+req.call_params[0],true);
	if (parsed && parsed.query && parsed.query.fl){
		req.fieldSelection = parsed.query.fl.split(",");
	}
	next();
}
