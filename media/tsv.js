var debug = require("debug")("p3api-server:media/tsv");
var when = require("promised-io/promise").when;
var es = require("event-stream");

module.exports = {
	contentType: "text/tsv",
	serialize: function(req, res, next){
		debug("application/tsv handler");
		debug("Method: ", req.call_method);
		var fields = req.fieldSelection;
		var header = req.fieldHeader;

		if(req.isDownload){
			res.attachment('patric3_' + req.call_collection + '_query.txt');
			// res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.txt"');
		}

		if(req.call_method == "stream"){
			when(res.results, function(results){
				var docCount = 0;
				var head;
				results.stream.pipe(es.mapSync(function(data){
					if(!head){
						head = data;
					}else{
						if(!fields && docCount < 1){
							fields = Object.keys(data);
						}
						if(docCount < 1){
							if(header){
								res.write(header.join("\t") + "\n");
							}else{
								res.write(fields.join("\t") + "\n");
							}
						}
						const row = fields.map(function(field){
							if(data[field] instanceof Array){
								return JSON.stringify(data[field].join(";"));
							}
							return JSON.stringify(data[field]);
						});
						res.write(row.join("\t") + "\n");
						docCount++;
					}
				})).on('end', function(){
					res.end();
				})
			});
		}else if(req.call_method == "query"){
			debug("query response: ", res.results);
			if(res.results && res.results.response && res.results.response.docs){
				if(!fields){
					fields = Object.keys(res.results.response.docs[0]);
				}
				res.write(fields.join("\t") + "\n");
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return JSON.stringify(o[field]);
					});
					// debug("row: ", row);
					res.write(row.join("\t") + "\n");
				});
				res.end();
			}
		}else{
			next(new Error("Unable to serialize request to csv"))

		}
	}
};
