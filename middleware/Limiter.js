var maxLimit=25000;
var defaultLimit=25;

module.exports = function(req,res,next){
	if (req.call_method!="query") { return next(); }
	var limit = maxLimit;
	var q = req.call_params[0];
	var re = /(&rows=)(\d*)/;
	var gre = /&group=true/	
	var grematches = q.match(gre);
	var matches = q.match(re);
	if (grematches || req.isDownload){
		limit=99999999;
	}else{
		//console.log("MATCHES: ", matches);
		if (!matches){
			//console.log("!matches && isDownload: ", req.isDownload);
			limit = defaultLimit;
		} else if (req.isDownload) {
			//console.log("Using Download Limit");
			limit = maxLimit;
		}else  if (matches && typeof matches[2]!='undefined' && (matches[2]>maxLimit) && (!req.isDownload)){
			//console.log("!isDownload ... set limit to: ", maxLimit);
			limit=maxLimit
		}else{
			//console.log("use specified limit: ", matches[2]);
			limit=matches[2];
		}
	}
	if (req.headers.range) {
		var range = req.headers.range.match(/^items=(\d+)-(\d+)?$/);
		//console.log("Range: ", range);
		if (range){
			start = range[1] || 0;
			end = range[2] || maxLimit;
			var l = end - start;
			if (l>maxLimit){
				limit=maxLimit;
			}else{
				limit=l;
			}

			var queryOffset=start;
		}
	}


	if (matches){
		req.call_params[0]= q.replace(matches[0],"&rows="+limit);
	}else{
		req.call_params[0] = req.call_params[0] + "&rows=" + limit;
	}

	if (queryOffset) {
		re = /(&start=)(\d+)/;
		var offsetMatches = q.match(re);
		if (!offsetMatches){
			req.call_params[0] = req.call_params[0] + "&start=" + queryOffset;
		}
	}

	
	next();
}
