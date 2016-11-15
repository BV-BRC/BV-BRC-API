var debug = require('debug')('p3api-server:FieldSelection');
var url = require("url");

module.exports = function(req, res, next) {
	if ((req.call_method !="query") && (req.call_method != "stream")){ return next(); }

	req.call_params[0] = req.call_params[0] || "&q=*:*";

	var parsed = url.parse("?"+req.call_params[0],true);
	if (parsed && parsed.query && parsed.query.fl){
		req.fieldSelection = parsed.query.fl.split(",");
	}else{

		switch(req.call_collection){
			case "genome_feature":
				req.fieldSelection = ["genome_name", "accession", "patric_id", "refseq_locus_tag", "alt_locus_tag", "feature_id",
						"annotation", "feature_type", "start", "end", "na_length", "strand", "protein_id", "aa_length", "gene", "product"
				];
				break;
			case "genome":	
				req.fieldSelection = [
					"genome_id", "genome_name", "organism_name", "taxon_id", "genome_status",
					"strain", "serovar", "biovar", "pathovar", "mlst", "other_typing",
					"culture_collection", "type_strain","completion_date", "publication",
					"bioproject_accession", "biosample_accession", "assembly_accession", "genbank_accessions",
					"refseq_accessions","sequencing_centers", "sequencing_status", "sequencing_platform",
					"sequencing_depth", "assembly_method","chromosomes", "plasmids", "contigs", "sequences", 
					"genome_length", "gc_content","patric_cds", "brc1_cds", "refseq_cds",
					"isolation_site", "isolation_source", "isolation_comments", "collection_date",
					"isolation_country", "geographic_location", "latitude", "longitude", "altitude", "depth", "other_environmental",
					"host_name", "host_gender", "host_age", "host_health", "body_sample_site", "body_sample_subsite", "other_clinical",
					"antimicrobial_resistance", "antimicrobial_resistance_evidence","gram_stain", "cell_shape", "motility", 
					"sporulation", "temperature_range", "optimal_temperature", "salinity", "oxygen_requirement","habitat",
					"disease", "comments", "additional_metadata"
				]
				break;
		}
	}

	next();
}
