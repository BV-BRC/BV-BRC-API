
module.exports = function(req,res,next) {
	console.log("Content Range middleware: ", req.call_method);
	if ( req.call_method != "query"){
		return next();
	}
	if (!res.results || res.results.length<1){
		res.set("Content-Range", "items 0-0/0");
	}else if (res.results && res.results.response && res.results.response.docs){
		res.set("Content-Range", "items " + (res.results.response.start || 0) + "-" + ((res.results.response.start||0)+res.results.response.docs.length) + "/" + res.results.response.numFound);
	}
	next();
}
