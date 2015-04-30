var debug = require('debug')('p3api-server:media');
var nodeExcel = require('excel-export');
module.exports=function(req,res,next){
	var rpcTypes = ["application/jsonrpc.result+json", "application/jsonrpc+json"];

	if (rpcTypes.some(function(t){
		return req.is(t);
	})){
		debug("RPC Request");
	}

	var fields;

	if (req.call_collection=="genome_feature"){
		fields = ["genome_name", "accession", "seed_id", "refseq_locus_tag", "alt_locus_tag", "feature_id",
				"annotation", "feature_type", "start", "end", "na_length", "strand", "protein_id", "aa_length", "gene", "product"
		];
	}else if (req.call_collection =="genome") {
		fields = ["genome_id", "genome_name", "organism_name", "taxon_id", "genome_status",
			"strain", "serovar", "biovar", "pathovar", "mlst", "other_typing",
			"culture_collection", "type_strain",
			"completion_date", "publication",
			"bioproject_accession", "biosample_accession", "assembly_accession", "genbank_accessions",
			"refseq_accessions",
			"sequencing_centers", "sequencing_status", "sequencing_platform", "sequencing_depth", "assembly_method",
			"chromosomes", "plasmids", "contigs", "sequences", "genome_length", "gc_content",
			"patric_cds", "brc1_cds", "refseq_cds",
			"isolation_site", "isolation_source", "isolation_comments", "collection_date",
			"isolation_country", "geographic_location", "latitude", "longitude", "altitude", "depth", "other_environmental",
			"host_name", "host_gender", "host_age", "host_health", "body_sample_site", "body_sample_subsite", "other_clinical",
			"antimicrobial_resistance", "antimicrobial_resistance_evidence",
			"gram_stain", "cell_shape", "motility", "sporulation", "temperature_range", "optimal_temperature", "salinity", "oxygen_requirement",
			"habitat",
			"disease", "comments", "additional_metadata"
		]
	}



	res.format({
		"application/dna+fasta": function(){
			debug("application/fna handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric_genomes.fasta");
			}

			//console.log("res.results: ", res.results);

			if (res.results && res.results.response && res.results.response.docs) {
				res.results.response.docs.forEach(function(o){
					var row = ">" + o.seed_id + "|"+o.feature_id+ " " + o.product + "\n" + o.na_sequence + "\n"; 
					res.write(row);
				});	
			}

			res.end();

		},

		"application/protein+fasta": function(){
			debug("application/dna+fasta handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric_proteins.fasta");
			}

			//console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				res.results.response.docs.forEach(function(o){
					var fasta_id;
					if (o.feature_type=="source") { return; }
					if (o.annotation == "PATRIC") {
						fasta_id = o.seed_id + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
					} else if (o.annotation == "RefSeq") {
						fasta_id = "gi|" + o.gi + "|"+(o.refseq_locus_tag?(o.refseq_locus_tag+"|"):"") + (o.alt_locus_tag?(o.alt_locus_tag+"|"):"");
					}
					var row = ">" + fasta_id + "   " + o.product + "   [" + o.genome_name + " | " + o.genome_id + "]\n" + o.aa_sequence + "\n"; 
					res.write(row);
				});	
			}

			res.end();
		},
		"application/gff": function(){
			debug("application/dna+fasta handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric_proteins.fasta");
			}

			//console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs && res.results.response.docs.length>0) {
				res.write("##gff-version 3\n");
				res.write("#Genome: " + res.results.response.docs[0].genome_id + "\t" + res.results.response.docs[0].genome_name);
				if (res.results.response.docs[0].product) {
					res.write(" " + res.results.response.docs[0].product);
				}
				res.write("\n");
				res.results.response.docs.forEach(function(o){
					if (o.feature_type=="source") {
						o.feature_type="region"
					}
					if (o.feature_type=="misc_RNA"){
						o.feature_type="transcript"
					}

					if (o.feature_type=="region") {
						res.write("##sequence-region\taccn" + o.accession + "\t" + o.start + "\t" + o.end + "\n");
						return;
					}

					res.write( "accn|" + o.accession+ "\t"+o.annotation+ "\t" + o.feature_type + "\t" + o.start+ "\t" + o.end + "\t.\t" + o.strand+"\t0\t");
					switch(o.annotation) {
						case "PATRIC":
							res.write("ID=" + o.seed_id);
							break;
						case "RefSeq":
							res.write("ID=" + o.refseq_locus_tag);
							break;
					}	

					if (o.refseq_locus_tag) {
						res.write(";locus_tag=" + o.refseq_locus_tag);
					}
				
					if (o.product) {
						res.write(";product=" +o.product);
					}

					if (o.gene) {
						res.write(";gene=" + o.gene);
					}	
					
					if (o.go) {
						res.write(";Ontology_term=" + o.go);
					}

					if (o.ec) {
						res.write(";ec_number=" + o.ec.join("|"));
					}
						
					res.write("\n");
				});	
			}

			res.end();
		},


		"text/csv": function(){
			debug("text/csv handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric3_query.csv");
			}

			//console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				if (!fields) {
					fields = Object.keys(res.results.response.docs[0]);
				}

				res.write(fields.join(",") + "\n");
				//console.log("Fields: ", fields);
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return JSON.stringify(o[field]);	
					});
					//console.log("row: ", row);
					res.write(row.join(",") + "\n");
				});	
			}

			res.end();
		},
		"text/tsv": function(){
			debug("text/tsv handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric3_query.txt");
			}
			//console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				if (!fields) { 
					fields = Object.keys(res.results.response.docs[0]);
				}
				res.write(fields.join("\t") + "\n");
				//console.log("Fields: ", fields);
				res.results.response.docs.forEach(function(o){
					var row = fields.map(function(field){
						return o[field];	
					});
					//console.log("row: ", row);
					res.write(row.join("\t") + "\n");
				});	
			}

			res.end();
		},
		"application/vnd.openxmlformats": function(){
			debug("Excel  handler")
			if (req.isDownload){
				req.set("content-disposition", "attachment; filename=patric3_query.xlsx");
			}
			var excelConf = {cols: []}

//			//console.log("res.results: ", res.results);
			if (res.results && res.results.response && res.results.response.docs) {
				//console.log("Build Excel Columns");
				if (!fields) { 
					fields = Object.keys(res.results.response.docs[0]);
				}
				//console.log("fields: ", fields);

				fields.forEach(function(field){
					if (res.results.response.docs[0] && res.results.response.docs[0][field]) {
						var fd = res.results.response.docs[0][field];
						if (typeof fd=="number"){
							excelConf.cols.push({caption: field, type: "number"});
						}else{
							excelConf.cols.push({caption: field, type: "string"});
						}	
					}else{
						excelConf.cols.push({caption: field, type: "string"});
					}
				});

				//console.log("excelconf: ", excelConf);
				excelConf.rows = res.results.response.docs.map(function(o){
					var row = fields.map(function(field){
						if (typeof o[field] == "object") {
							if (o[field] instanceof Array) {
								return o[field].join(";");
							}
							return JSON.stringify(o[field]);
						}
						return o[field] || "";	
					});
					return row;
				});

				//console.log("Excel Conf: ", excelConf);
				var d = nodeExcel.execute(excelConf);
				//console.log("Node Excel Data Exported");
				res.set("Content-Type", "application/vnd.openxmlformats");
				res.end(d, "binary");	
			}

			res.end();
	
		},

		"application/solr+json": function(){
			debug("application/json handler")	
			res.send(JSON.stringify(res.results));
			res.end();
		},

		"application/json": function(){
			debug("application/json handler")	
			if (req.call_method=="query"){
				if (res.results && res.results.response && res.results.facet_counts){
					res.set("facet_counts", JSON.stringify(res.results.facet_counts));
				}
				if (res.results && res.results.response && res.results.response.docs){
					res.send(JSON.stringify(res.results.response.docs));
				}else{
					res.status(404);
				}
			} else{
					if (!res.results || !res.results.doc){
						res.status(404)
					}else{
						res.send(JSON.stringify(res.results.doc));
					}
			}
			res.end();
		}
	})
}
