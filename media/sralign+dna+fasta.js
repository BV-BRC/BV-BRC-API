var debug = require("debug")("p3api-server:media/sralign+dna+fasta");
var when = require("promised-io/promise").when;
var es = require("event-stream");
var wrap = require("../util/linewrap");

function serializeRow(type, o){
	if(type == "genome_feature"){
		var row = ">" + o.patric_id + "|" + o.feature_id + " " + o.product;
		return row + wrap(o.na_sequence, 60) + "\n";
	}else if(type == "genome_sequence"){
		var row = ">" + o.accession + "   " + o.description + "   " + "[" + (o.genome_name || o.genome_id) + "]\n";
		return row + wrap(o.sequence, 60) + "\n";
	}else{
		throw Error("Cannot query for application/protein+fasta from this data collection");
	}

}

module.exports = {
	contentType: "application/sralign+dna+fasta",
	serialize: function(req, res, next){
		debug("application/sralign+dna+fasta");

		if(req.isDownload){
			res.attachment('PATRIC_' + req.call_collection + '.fasta');
			// res.set("content-disposition", "attachment; filename=patric_genomes.fasta");
		}

		if(req.call_method == "stream"){
			when(res.results, function(results){
				// debug("res.results: ", results);
				var docCount = 0;
				var head;

				if(!results.stream){
					throw Error("Expected ReadStream in Serializer")
				}

				results.stream.pipe(es.mapSync(function(data){
					if(!head){
						head = data;
					}else{
						// debug(JSON.stringify(data));
						res.write(serializeRow(req.call_collection, data));
						docCount++;
					}
				})).on('end', function(){
					debug("Exported " + docCount + " Documents");
					res.end();
				})
			});
		}else{
			if(res.results && res.results.response && res.results.response.docs){
				res.results.response.docs.forEach(function(o){
					res.write(serializeRow(req.call_collection, o));
				});
			}
			res.end();
		}
	}
};
