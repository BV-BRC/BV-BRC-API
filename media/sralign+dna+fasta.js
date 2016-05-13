var debug = require("debug")("media");
var when = require("promised-io/promise").when;
var es = require("event-stream");

var wrap = function(str,linelen){
	if (!str){ str = "" }
	if (str.length <= linelen ){
		return str;
	}
	var out=[];
	var cur=0;
	while (cur < str.length){
		if (cur+linelen>str.length){
			out.push(str.slice(cur,str.length-1));
			cur = str.length;
		}else{
			out.push(str.slice(cur, cur + linelen))
			cur = cur + linelen + 1;
		}
	}	
	return out.join("\n");	

}

function serializeRow(type,o){
	if (req.call_collection=="genome_feature"){
		var row = ">" + o.patric_id + "|"+o.feature_id+ " " + o.product; 
		return row + wrap(o.na_sequence,60) + "\n";
	}else if (req.call_collection="genome_sequence") {
		var row = ">"+ o.accession + "   " + o.description + "   " + "["+(o.genome_name|| o.genome_id) +"]\n";
		return row + wrap(o.sequence,60) + "\n";
	}else{
		throw Error("Cannot query for application/protein+fasta from this data collection");
	}

}


module.exports = {
	contentType: "application/sralign+dna+fasta",
	serialize: function(req,res,next){
		debug("application/sralign+dna+fasta")

		if (req.isDownload){
			res.set("content-disposition", "attachment; filename=patric_genomes.fasta");
		}

		if (req.call_method=="stream"){
			when(res.results, function(results){
				debug("res.results: ", results)
				var docCount=0;
				var head;
				
				if (!results.stream){
					throw Error("Expected ReadStream in Serializer")
				}

				results.stream.pipe(es.mapSync(function(data){
			            if (!head){
			                    head = data;
			            }else{
		                    // console.log(JSON.stringify(data));
		                   res.write(serializeRow(req.call_collection,data));
		                   docCount++;
			            }
			    })).on('end', function(){
			    	console.log("Exported " + docCount + " Documents");
			    	res.end();
			    })
			});
		}else{
			if (res.results && res.results.response && res.results.response.docs) {
				res.results.response.docs.forEach(function(o){
					res.write(serializeRow(req.call_collection,o));
				});
			}
			res.end();
		}
	}
}
