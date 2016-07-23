var debug = require("debug")("media");
var when = require("promised-io/promise").when;
var es = require("event-stream");
var wrap = require("../util/linewrap");

function serializeRow(type,o){
	if (type=="genome_feature"){
		var fasta_id,row;
	    if (o.annotation == "PATRIC") {
			fasta_id = o.patric_id + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
	    } else if (o.annotation == "RefSeq") {
            fasta_id = "gi|" + o.gi + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
        }else{
			throw Error("Unknown Annotation Type: " + o.annotation);
		}

    	row = ">" + fasta_id + "   " + o.product + "   [" + o.genome_name + " | " + o.genome_id + "]\n";
		row = row + wrap(o.na_sequence,60) + "\n";
		return row;

	}else if (req.call_collection="genome_sequence") {
		row = ">accn|" + o.accession + "   " + o.description + "   " + "["+(o.genome_name||"") + " | " +   (o.genome_id||"") +"]\n";
		row = row + wrap(o.sequence,60) + "\n";
		return row;
	}else{
		throw Error("Cannot serialize " + type + " to application/dna+fasta");
	}

}


module.exports = {
	contentType: "application/dna+fasta",
	serialize: function(req,res,next){
		debug("application/dna+fastahandler")

		if (req.isDownload){
			// res.set("content-disposition", "attachment; filename=patric_genomes.fasta");
			res.attachment('patric3_' + req.call_collection + '.fasta');
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
