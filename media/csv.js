var debug = require('debug')('p3api-server:media/csv');
var when = require("promised-io/promise").when;
var es = require("event-stream");

module.exports = {
	contentType: "text/csv",
	serialize: function(req, res, next){
		debug("application/csv handler");
		debug("Method: ", req.call_method);
		var fields = req.fieldSelection;
		var header = req.fieldHeader;

		if(req.isDownload){
			res.attachment('patric3_' + req.call_collection + '_query.csv');
			//res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.csv"');
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
								res.write(header.join(",") + "\n");
							}else{
								res.write(fields.join(",") + "\n");
							}
						}

						// debug(JSON.stringify(data));
						var row = fields.map(function(field){
							if (data[field] instanceof Array){
								return '"' + data[field].join(";") + '"'
							}else if (data[field]){
								if (typeof data[field]=="string"){
									return '"' + data[field] + '"'
								}else{
									return data[field];
								}
							}else{
								return "";
							}

						});
						res.write(row.join(",") + "\n");
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
				res.write(fields.join(",") + "\n");
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						if (o[field] instanceof Array){
							return '"' + o[field].join(";") + '"'
						}else if (o[field]){
							if (typeof o[field]=="string"){
								return '"' + o[field] + '"'
							}else{
								return o[field];
							}
						}else{
							return "";
						}
					});
					// debug("row: ", row);
					res.write(row.join(",") + "\n");
				});
				res.end();
			}
		}else{
			next(new Error("Unable to serialize request to csv"))

		}
	}
};
