var debug = require("debug")("media");
var when = require("promised-io/promise").when;
var es = require("event-stream");

module.exports = {
	contentType: "text/csv",
	serialize: function(req,res,next){
		debug("application/csv handler")

		var fields = req.fieldSelection;

		if (req.isDownload){
			res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.csv"');
		}


		if (req.call_method=="stream"){
			when(res.results, function(results){
				var docCount=0;
				res.write("[");
				var head;
				results.stream.pipe(es.mapSync(function(data){
			            if (!head){
			                    head = data;
			            }else{

							if (!fields && docCount<1) {
								fields = Object.keys(data);
							}

		                    // console.log(JSON.stringify(data));
  		                   	var row = fields.map(function(field){
								return JSON.stringify(data[field]);	
							});
		                   res.write(row.join(",") + "\n");
		                   docCount++;
			            }
			    })).on('end', function(){
			    	res.end();
			    })
			});
		} else if (req.call_method=="query"){
			if (res.results && res.results.response && res.results.response.docs) {
				if (!fields) {
					fields = Object.keys(res.results.response.docs[0]);
				}

				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return JSON.stringify(o[field]);	
					});
					//console.log("row: ", row);
					res.write(row.join(",") + "\n");
				});
			}
		} else{
			next(new Error("Unable to serialize request to csv"))

		}
	}
}
