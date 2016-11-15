var debug = require("debug")("p3api-server:media/excel");
var xlsx = require('node-xlsx');

module.exports = {
	contentType: "application/vnd.openxmlformats",
	serialize: function(req, res, next){
		debug("Excel  handler. download: ", req.isDownload);
			// debug("Headers: ", req.headers);
		if(req.isDownload){
			debug("EXCEL SET ATTACHMENT: ", 'patric3_' + req.call_collection + '_query.xlsx');
			res.attachment('patric3_' + req.call_collection + '_query.xlsx');
			// res.set("content-disposition", 'attachment; filename="patric3_' + req.call_collection + '_query.xlsx"');
		}

		res.set("Content-Type", "application/vnd.openxmlformats");

//			//debug("res.results: ", res.results);
		if(res.results && res.results.response && res.results.response.docs){
			// debug("Build Excel Columns");
			var fields = req.fieldSelection;

			if(!fields){
				fields = Object.keys(res.results.response.docs[0]);
			}
			// debug("fields: ", fields);
			var data = res.results.response.docs.map(function(o){
				var row = fields.map(function(field){
					if(typeof o[field] == "object"){
						if(o[field] instanceof Array){
							return o[field].join(";");
						}
						return JSON.stringify(o[field]);
					}
					return o[field] || "";
				});
				return row;
			});

			data.unshift(fields);
			var d = xlsx.build([{name: "patric3_query", data: data}]);
			res.end(d, "binary");
		}else{
			res.status(404);
			//res.end();
		}
	}
};
