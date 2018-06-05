var debug = require('debug')('p3api-server:FieldSelection');
var url = require("url");

module.exports = function(req, res, next){
	if((req.call_method != "query") && (req.call_method != "stream")){
		return next();
	}

	req.call_params[0] = req.call_params[0] || "&q=*:*";

	const parsed = url.parse("?" + req.call_params[0], true);
	if(parsed && parsed.query && parsed.query.fl){
		req.fieldSelection = parsed.query.fl.split(",");
	}else{

		switch(req.call_collection){
			case "genome_feature":
				req.fieldHeader = [
					"Genome", "Genome ID", "Accession", "PATRIC ID", "RefSeq Locus Tag", "Alt Locus Tag",
					"Feature ID", "Annotation", "Feature Type", "Start", "End", "Length", "Strand", "FIGfam ID",
					"PATRIC genus-specific families (PLfams)", "PATRIC cross-genus families (PGfams)", "Protein ID",
					"AA Length", "Gene Symbol", "Product", "GO"
				];
				req.fieldSelection = [
					"genome_name", "genome_id", "accession", "patric_id", "refseq_locus_tag", "alt_locus_tag",
					"feature_id", "annotation", "feature_type", "start", "end", "na_length", "strand", "figfam_id",
					"plfam_id", "pgfam_id",
					"protein_id", "aa_length", "gene", "product", "go"
				];
				break;
			case "genome":
				req.fieldHeader = [
					"Genome ID", "Genome Name", "Organism Name", "NCBI Taxon ID", "Genome Status",
					"Strain", "Serovar", "Biovar", "Pathovar", "MLST", "Other Typing",
					"Culture Collection", "Type Strain",
					"Completion Date", "Publication",
					"BioProject Accession", "BioSample Accession", "Assembly Accession", "GenBank Accessions",
					"RefSeq Accessions",
					"Sequencing Centers", "Sequencing Status", "Sequencing Platform", "Sequencing Depth", "Assembly Method",
					"Chromosomes", "Plasmids", "Contigs", "Genome Length", "GC Content",
					"PATRIC CDS", "RefSeq CDS",
					"Isolation Site", "Isolation Source", "Isolation Comments", "Collection Date",
					"Isolation Country", "Geographic Location", "Latitude", "Longitude", "Altitude", "Depth", "Other Environmental",
					"Host Name", "Host Gender", "Host Age", "Host Health", "Body Sample Site", "Body Sample Subsite", "Other Clinical",
					"AntiMicrobial Resistance", "AntiMicrobial Resistance Evidence",
					"Gram Stain", "Cell Shape", "Motility", "Sporulation", "Temperature Range", "Optimal Temperature", "Salinity", "Oxygen Requirement",
					"Habitat",
					"Disease", "Comments", "Additional Metadata", "Date Inserted", "Date Modified"
				];
				req.fieldSelection = [
					"genome_id", "genome_name", "organism_name", "taxon_id", "genome_status",
					"strain", "serovar", "biovar", "pathovar", "mlst", "other_typing",
					"culture_collection", "type_strain",
					"completion_date", "publication",
					"bioproject_accession", "biosample_accession", "assembly_accession", "genbank_accessions",
					"refseq_accessions",
					"sequencing_centers", "sequencing_status", "sequencing_platform", "sequencing_depth", "assembly_method",
					"chromosomes", "plasmids", "contigs", "genome_length", "gc_content",
					"patric_cds", "refseq_cds",
					"isolation_site", "isolation_source", "isolation_comments", "collection_date",
					"isolation_country", "geographic_location", "latitude", "longitude", "altitude", "depth", "other_environmental",
					"host_name", "host_gender", "host_age", "host_health", "body_sample_site", "body_sample_subsite", "other_clinical",
					"antimicrobial_resistance", "antimicrobial_resistance_evidence",
					"gram_stain", "cell_shape", "motility", "sporulation", "temperature_range", "optimal_temperature", "salinity", "oxygen_requirement",
					"habitat",
					"disease", "comments", "additional_metadata", "date_inserted", "date_modified"
				];
				break;
			case "genome_sequence":
				req.fieldHeader = [
					"Genome ID", "Genome Name", "Sequence ID", "GI", "Accession", "Sequence Type", "Topology", "Description",
					"GC Content", "Length (bp)", "Release Date", "Version"
				];
				req.fieldSelection = [
					"genome_id", "genome_name", "sequence_id", "gi", "accession", "sequence_type", "topology", "description",
					"gc_content", "length", "release_date", "version"
				];
				break;
			case "genome_amr":
				req.fieldHeader = [
					"Taxon ID", "Genome ID", "Genome Name", "Antibiotic", "Resistant Phenotype",
					"Measurement", "Measurement Sign", "Measurement Value", "Measurement Unit",
					"Laboratory Typing Method", "Laboratory Typing Method Version", "Laboratory Typing Platform", "Vendor",
					"Testing Standard", "Testing Standard Year", "Source"
				];
				req.fieldSelection = [
					"taxon_id", "genome_id", "genome_name", "antibiotic", "resistant_phenotype",
					"measurement", "measurement_sign", "measurement_value", "measurement_unit",
					"laboratory_typing_method", "laboratory_typing_method_version", "laboratory_typing_platform", "vendor",
					"testing_standard", "testing_standard_year", "source"
				];
				break;
			case "sp_gene":
				req.fieldHeader = [
					"Evidence", "Property", "Source", "Genome Name", "PATRIC ID", "RefSeq Locus Tag", "Alt Locus Tag", "Source ID",
					"Source Organism", "Gene", "Product", "Function", "Classification", "PubMed", "Subject Coverage", "Query Coverage",
					"Identity", "E-value"
				];
				req.fieldSelection = [
					"evidence", "property", "source", "genome_name", "patric_id", "refseq_locus_tag", "alt_locus_tag", "source_id",
					"organism", "gene", "product", "function", "classification", "pmid", "subject_coverage", "query_coverage", "identity",
					"e_value"
				];
				break;
			case "sp_gene_ref":
				req.fieldHeader = [
					"Property", "Source", "Source ID", "Gene", "Organism", "Locus Tag", "Gene ID", "GI", "Product",
					"Function", "Classification", "PubMed"
				];
				req.fieldSelection = [
					"property", "source", "source_id", "gene_name", "organism", "locus_tag", "gene_id", "gi", "product",
					"function", "classification", "pmid"
				];
				break;
			case "transcriptomics_experiment":
				req.fieldHeader = [
					"Experiment ID", "Title", "Comparisons", "Genes", "PubMed", "Accession", "Organism", "Strain",
					"Gene Modification", "Experimental Condition", "Time Series", "Release Date", "Author", "PI", "Institution"
				];
				req.fieldSelection = [
					"eid", "title", "samples", "genes", "pmid", "accession", "organism", "strain", "mutant",
					"condition", "timeseries", "release_date", "author", "pi", "institution"
				];
				break;
			case "transcriptomics_sample":
				req.fieldHeader = [
					"Experiment ID", "Comparison ID", "Title", "Genes", "Significant genes(Log Ratio)",
					"Significant genes(Z Score)", "PubMed", "Accession", "Organism", "Strain", "Gene Modification", "Experiment Condition",
					"Time Point", "Release Date"
				];
				req.fieldSelection = [
					"eid", "pid", "expname", "genes", "sig_log_ratio", "sig_z_score", "pmid", "accession",
					"organism", "strain", "mutant", "condition", "timepoint", "release_date"
				];
				break;
			case "interaction":
			case "ppi":
				req.fieldHeader = [
					"Interactor A ID", "Interactor A Type", "Interactor A Desc",
					"Domain A", "Taxon ID A", "Genome ID A", "Genome Name A", "RefSeq Locus Tag A", "gene A",
					"Interactor B ID", "Interactor B Type", "Interactor B Desc",
					"Domain B", "Taxon ID B", "Genome ID B", "Genome Name B", "RefSeq Locus Tag B", "gene B",
					"Category", "Interaction Type", "Detection Method", "Evidence",
					"PMID", "Source DB", "Source ID", "Score"
				];
				req.fieldSelection = [
					"interactor_a", "interactor_type_a", "interactor_desc_a",
					"domain_a", "taxon_id_a", "genome_id_a", "genome_name_a", "refseq_locus_tag_a", "gene_a",
					"interactor_b", "interactor_type_b", "interactor_desc_b",
					"domain_b", "taxon_id_b", "genome_id_b", "genome_name_b", "refseq_locus_tag_b", "gene_b",
					"category", "interaction_type", "detection_method", "evidence",
					"pmid", "source_db", "source_id", "score"
				];
				break;
			default:
				break;
		}
	}

	next();
};
