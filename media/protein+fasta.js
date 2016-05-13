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
	var fasta_id;
	if (o.feature_type=="source") { return; }
	if (o.annotation == "PATRIC") {
		fasta_id = o.patric_id + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
	} else if (o.annotation == "RefSeq") {
		fasta_id = "gi|" + o.gi + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
	}
	var row = ">" + fasta_id + "   " + o.product + "   [" + o.genome_name + " | " + o.genome_id + "]\n";
	return row + wrap(o.aa_sequence,60) + "\n"
}


module.exports = {
	contentType: "application/protein+fasta",
	serialize: function(req,res,next){
		debug("application/dna+fastahandler")

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
			            console.log("STREAM DATA: ", data);
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
