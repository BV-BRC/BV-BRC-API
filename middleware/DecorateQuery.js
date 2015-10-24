var debug = require('debug')('p3api-server:DecorateQuery');


module.exports = function(req, res, next) {
	if (req.call_method !="query"){ return next(); }

	debug("decorateQuery", req.solr_query);
	req.call_params[0] = req.call_params[0] || "&q=*:*";
	if (!req.user) {
		if (!req.publicFree || (req.publicFree && (req.publicFree.indexOf(req.call_collection)<0))) {
			req.call_params[0] = req.call_params[0] + "&fq=public:true"
		}
	}
	else {
		if (!req.publicFree || (req.publicFree && (req.publicFree.indexOf(req.call_collection)<0))) {
			req.call_params[0]= req.call_params[0] + ("&fq=(public:true OR owner:" + req.user +" OR user_read:" + req.user +")");
		}
	}

	next();
}