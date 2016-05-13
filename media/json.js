var debug = require("debug")("media");
var when = require("promised-io/promise").when;
var es = require("event-stream");

module.exports = {
	contentType: "application/json",
	serialize: function(req,res,next){
		debug("application/json handler")
		if (req.call_method=="stream"){
			when(res.results, function(results){
				debug("res.results: ", results)
				var docCount=0;
				res.write("[");
				var head;
				results.stream.pipe(es.mapSync(function(data){
			            console.log("STREAM DATA: ", data);
			            if (!head){
			                    head = data;
			            }else{
		                    // console.log(JSON.stringify(data));
		                   res.write(((docCount>0)?",":"") + JSON.stringify(data));
		                   docCount++;
			            }
			    })).on('end', function(){
			    	console.log("Exported " + docCount + " Documents");
			    	res.write("]");
			    	res.end();
			    })
			});
		} else if (req.call_method=="query"){
			if (res.results && res.results.response && res.results.facet_counts){
				res.set("facet_counts", JSON.stringify(res.results.facet_counts));
			}
			if (res.results && res.results.response && res.results.response.docs){
				res.send(JSON.stringify(res.results.response.docs));
			}else if (res.results && res.results.grouped){
				res.send(JSON.stringify(res.results.grouped))
			}else{
				res.status(404);
			}
			res.end();
		} else {
			if (!res.results || !res.results.doc){
				res.status(404)
			}else{
				res.send(JSON.stringify(res.results.doc));
			}
			res.end();
		}
	}
}
