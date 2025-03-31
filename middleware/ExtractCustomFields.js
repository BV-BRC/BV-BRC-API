var url = require('url')

module.exports = function (req, res, next) {
  if ((req.call_method !== 'query') && (req.call_method !== 'stream')) {
    return next()
  }

  req.call_params[0] = req.call_params[0] || '&q=*:*'

  const parsed = url.parse('?' + req.call_params[0], true)
  if (parsed && parsed.query && parsed.query.fl) {
    req.fieldSelection = parsed.query.fl.split(',')
  } else {
    switch (req.call_collection) {
      case 'genome_feature':
        req.fieldHeader = [
          'Genome', 'Genome ID', 'Accession', 'BRC ID', 'RefSeq Locus Tag', 'Alt Locus Tag',
          'Feature ID', 'Annotation', 'Feature Type', 'Start', 'End', 'Length', 'Strand', 'FIGfam ID',
          'PATRIC genus-specific families (PLfams)', 'PATRIC cross-genus families (PGfams)', 'Protein ID',
          'AA Length', 'Gene Symbol', 'Product', 'GO'
        ]
        req.fieldSelection = [
          'genome_name', 'genome_id', 'accession', 'patric_id', 'refseq_locus_tag', 'alt_locus_tag',
          'feature_id', 'annotation', 'feature_type', 'start', 'end', 'na_length', 'strand', 'figfam_id',
          'plfam_id', 'pgfam_id',
          'protein_id', 'aa_length', 'gene', 'product', 'go'
        ]
        break
      case 'genome':
        req.fieldHeader = ['Genome ID', 'Genome Name', 'Other Names', 'NCBI Taxon ID', 'Taxon Lineage IDs', 
                           'Taxon Lineage Names', 'Superkingdom', 'Kingdom', 'Phylum', 'Class', 'Order', 
                           'Family', 'Genus', 'Species', 
                           'Genome Status', 'Strain', 'Serovar', 'Biovar', 'Pathovar', 'MLST', 
                           'Segment', 'Subtype', 'H_type', 'N_type', 'H1 Clade Global', 'H1 Clade US', 'H5 Clade', 
                           'pH1N1-like', 'Lineage', 'Clade', 'Subclade', 'Other Typing', 
                           'Culture Collection', 'Type Strain', 'Reference', 'Genome Quality', 
                           'Completion Date', 'Publication', 'Authors', 'BioProject Accession', 'BioSample Accession', 
                           'Assembly Accession', 'SRA Accession', 'GenBank Accessions', 'Sequencing Center', 'Sequencing Status', 
                           'Sequencing Platform', 'Sequencing Depth', 'Assembly Method', 
                           'Chromosome', 'Plasmids', 'Contigs', 'Size', 'GC Content', 'Contig L50', 'Contig N50', 
                           'TRNA', 'RRNA', 'Mat Peptide', 'CDS', 'Coarse Consistency', 'Fine Consistency', 
                           'CheckM Contamination', 'CheckM Completeness', 'Genome Quality Flags', 
                           'Isolation Source', 'Isolation Comments', 'Collection Date', 'Collection Year', 
                           'Season', 'Isolation Country', 'Geographic Group', 'Geographic Location', 
                           'Other Environmental', 'Host Name', 'Host Common Name', 'Host Gender', 
                           'Host Age', 'Host Health', 'Host Group', 'Lab Host', 'Passage', 'Other Clinical', 
                           'Additional Metadata', 'Comments', 'Date Inserted', 'Date Modified']

        req.fieldSelection = ['genome_id', 'genome_name', 'other_names', 'taxon_id', 'taxon_lineage_ids', 
                              'taxon_lineage_names', 'superkingdom', 'kingdom', 'phylum', 'class', 'order', 
                              'family', 'genus', 'species', 
                              'genome_status', 'strain', 'serovar', 'biovar', 'pathovar', 'mlst', 
                              'segment', 'subtype', 'h_type', 'n_type', 'h1_clade_global', 'h1_clade_us', 'h5_clade', 
                              'ph1n1_like', 'lineage', 'clade', 'subclade', 'other_typing', 
                              'culture_collection', 'type_strain', 'reference_genome', 'genome_quality', 
                              'completion_date', 'publication', 'authors', 'bioproject_accession', 'biosample_accession', 
                              'assembly_accession', 'sra_accession', 'genbank_accessions', 'sequencing_centers', 'sequencing_status', 
                              'sequencing_platform', 'sequencing_depth', 'assembly_method', 
                              'chromosome', 'plasmids', 'contigs', 'genome_length', 'gc_content', 'contig_l50', 'contig_n50', 
                              'trna', 'rrna', 'mat_peptide', 'cds', 'coarse_consistency', 'fine_consistency', 
                              'checkm_contamination', 'checkm_completeness', 'genome_quality_flags', 
                              'isolation_source', 'isolation_comments', 'collection_date', 'collection_year', 
                              'season', 'isolation_country', 'geographic_group', 'geographic_location', 
                              'other_environmental', 'host_name', 'host_common_name', 'host_gender', 
                              'host_age', 'host_health', 'host_group', 'lab_host', 'passage', 'other_clinical', 
                              'additional_metadata', 'comments', 'date_inserted', 'date_modified']
        
        break
      case 'genome_sequence':
        req.fieldHeader = [
          'Genome ID', 'Genome Name', 'Sequence ID', 'GI', 'Accession', 'Sequence Type', 'Topology', 'Description',
          'GC Content', 'Length (bp)', 'Release Date', 'Version'
        ]
        req.fieldSelection = [
          'genome_id', 'genome_name', 'sequence_id', 'gi', 'accession', 'sequence_type', 'topology', 'description',
          'gc_content', 'length', 'release_date', 'version'
        ]
        break
      case 'genome_amr':
        req.fieldHeader = [
          'Taxon ID', 'Genome ID', 'Genome Name', 'Antibiotic', 'Resistant Phenotype',
          'Measurement', 'Measurement Sign', 'Measurement Value', 'Measurement Unit',
          'Laboratory Typing Method', 'Laboratory Typing Method Version', 'Laboratory Typing Platform', 'Vendor',
          'Testing Standard', 'Testing Standard Year',
          'Computational Method', 'Computational Method Version', 'Computational Method Performance',
          'Evidence', 'Source', 'PubMed'
        ]
        req.fieldSelection = [
          'taxon_id', 'genome_id', 'genome_name', 'antibiotic', 'resistant_phenotype',
          'measurement', 'measurement_sign', 'measurement_value', 'measurement_unit',
          'laboratory_typing_method', 'laboratory_typing_method_version', 'laboratory_typing_platform', 'vendor',
          'testing_standard', 'testing_standard_year',
          'computational_method', 'computational_method_version', 'computational_method_performance',
          'evidence', 'source', 'pmid'
        ]
        break
      case 'protein_structure':
        req.fieldHeader = [
          'PDB ID', 'Title', 'Organism Name', 'Taxon ID', 'Genome ID', 'BRC ID', 'UniProtKB Accession', 'Gene', 'Product',
          'Sequence MD5', 'Sequence', 'Alignments', 'Method', 'Resolution', 'PMID', 'Institution', 'Authors', 'Release Date'
        ]
        req.fieldSelection = [
          'pdb_id', 'title', 'organism_name', 'taxon_id', 'genome_id', 'patric_id', 'uniprotkb_accession', 'gene', 'product',
          'sequence_md5', 'sequence', 'alignments', 'method', 'resolution', 'pmid', 'institution', 'authors', 'release_date'
        ]
        break
      case 'protein_feature':
        req.fieldHeader = [
          'ID', 'Genome ID', 'Genome Name', 'Taxon ID', 'Feature ID', 'BRC ID', 'RefSeq Locus Tag', 'AA Sequence MD5', 'Gene', 'Product',
          'Interpro ID', 'Interpro Description', 'Feature Type', 'Source', 'Source ID', 'Description', 'Classification', 'Score',
          'E Value', 'Evidence', 'Publication', 'Start', 'End', 'Segments', 'Length', 'Sequence', 'Comments'
        ]
        req.fieldSelection = [
          'id', 'genome_id', 'genome_name', 'taxon_id', 'feature_id', 'patric_id', 'refseq_locus_tag', 'aa_sequence_md5', 'gene', 'product',
          'interpro_id', 'interpro_description', 'feature_type', 'source', 'source_id', 'description', 'classification', 'score',
          'e_value', 'evidence', 'publication', 'start', 'end', 'segments', 'length', 'sequence', 'comments'
        ]
        break
      case 'epitope':
        req.fieldHeader = [
          'Epitope ID', 'Epitope Type', 'Epitope Sequence', 'Organism', 'Taxon ID', 'Protein Name', 'Protein ID', 'Protein Accession',
          'Start', 'End', 'Total Assays', 'Bcell Assays', 'Tcell Assays', 'MCH Assays', 'Comments'
        ]
        req.fieldSelection = [
          'epitope_id', 'epitope_type', 'epitope_sequence', 'organism', 'taxon_id', 'protein_name', 'protein_id', 'protein_accession',
          'start', 'end', 'total_assays', 'bcell_assays', 'tcell_assays', 'mch_assays', 'comments'
        ]
        break
      case 'surveillance':
        req.fieldHeader = [
          'Project Identifier', 'Contributing Institution', 'Sample Identifier', 'Sequence Accession',
          'Sample Material', 'Sample Transport Medium', 'Sample Receipt Date', 'Submission Date', 'Last Udpdate Date', 'Longitudinal Study', 'Embargo End Date',
          'Collector Name', 'Collector Institution', 'Contact Email Address', 'Collection Date', 'Collection Year', 'Collection Season',
          'Days Elapsed to Sample Collection', 'Collection Country', 'Collection State Province', 'Collection City', 'Collection POI',
          'Collection Latitude', 'Collection Longitude', 'Pathogen Test Type', 'Pathogen Test Result', 'Pathogen Test Interpretation',
          'Species', 'Type', 'Subtype', 'Strain', 'Host Identifier', 'Host ID Type', 'Host Species', 'Host Common Name',
          'Host Group', 'Host Sex', 'Host Age', 'Host Height', 'Host Weight', 'Host Habitat', 'Host Natural State', 'Host Capture Status',
          'Host Health', 'Exposure', 'Duration of Exposure', 'Exposure Type', 'Use of Personal Protective Equipment', 'Primary Living Situation',
          'Nursing Home Residence', 'Daycare Attendance', 'Travel History', 'Profession', 'Education', 'Pregnancy', 'Trimester of Pregnancy', 'Breastfeeding',
          'Hospitalized', 'Hosptializaion Duration', 'Intensive Care Unit', 'Chest Imaging Interpretation', 'Ventilation',
          'Oxygen Saturation', 'Ecmo', 'Dialysis', 'Disease Status', 'Days Elapsed to Disease Status', 'Disease Severity', 'Alcohol Or Other Drug Use',
          'Tobacco Use', 'Packs Per Day For How Many Years', 'Chronic Conditions', 'Maintenance Medication', 'Types of Allergies', 'Influenza Like Illiness Over The Past Year',
          'Infections Within Five Years', 'Human Leukocyte Antigens', 'Symptoms', 'Onset Hours', 'Sudden Onset', 'Diagnosis', 'Pre Visit Medication',
          'Post Visit Medication', 'Treatment', 'Initiation Of Treatment', 'Duration of Treatment', 'Treatment Dosage', 'Vaccination Type',
          'Days Elapsed to Vaccination', 'Source of Vaccine Information', 'Vaccine Lot Number', 'Vaccine Manufacturer', 'Vaccine Dosage',
          'Other Vaccinations', 'Additional Metadata', 'Comments'
        ]
        req.fieldSelection = [
          'project_identifier', 'contributing_institution', 'sample_identifier', 'sequence_accession',
          'sample_material', 'sample_transport_medium', 'sample_receipt_date', 'submission_date', 'last_update_date', 'longitudinal_study', 'embargo_end_date',
          'collector_name', 'collector_institution', 'contact_email_address', 'collection_date', 'collection_year', 'collection_season',
          'days_elapsed_to_sample_collection', 'collection_country', 'collection_state_province', 'collection_city', 'collection_poi',
          'collection_latitude', 'collection_longitude', 'pathogen_test_type', 'pathogen_test_result', 'pathogen_test_interpretation',
          'species', 'type', 'subtype', 'strain', 'host_identifier', 'host_id_type', 'host_species', 'host_common_name',
          'host_group', 'host_sex', 'host_age', 'host_height', 'host_weight', 'host_habitat', 'host_natural_state', 'host_capture_status',
          'host_health', 'exposure', 'duration_of_exposure', 'exposure_type', 'use_of_personal_protective_equipment', 'primary_living_situation',
          'nursing_home_residence', 'daycare_attendance', 'travel_history', 'profession', 'education', 'pregnancy', 'trimester_of_pregnancy', 'breastfeeding',
          'hospitalized', 'hosptializaion_duration', 'intensive_care_unit', 'chest_imaging_interpretation', 'ventilation',
          'oxygen_saturation', 'ecmo', 'dialysis', 'disease_status', 'days_elapsed_to_disease_status', 'disease_severity', 'alcohol_or_other_drug_use',
          'tobacco_use', 'packs_per_day_for_how_many_years', 'chronic_conditions', 'maintenance_medication', 'types_of_allergies', 'influenza_like_illiness_over_the_past_year',
          'infections_within_five_years', 'human_leukocyte_antigens', 'symptoms', 'onset_hours', 'sudden_onset', 'diagnosis', 'pre_visit_medication',
          'post_visit_medication', 'treatment', 'initiation_of_treatment', 'duration_of_treatment', 'treatment_dosage', 'vaccination_type',
          'days_elapsed_to_vaccination', 'source_of_vaccine_information', 'vaccine_lot_number', 'vaccine_manufacturer', 'vaccine_dosage',
          'other_vaccinations', 'additional_metadata', 'comments'
        ]
        break
      case 'serology':
        req.fieldHeader = [
          'Project Identifier', 'Contributing Institution', 'Sample Identifier',
          'Host Identifier', 'Host Type', 'Host Species', 'Host Common Name', 'Host Sex', 'Host Age', 'Host Age Group', 'Host Health',
          'Collection Country', 'Collection State', 'Collection City', 'Collection Date', 'Collection Year',
          'Test Type', 'Test Result', 'Test Interpretation', 'Serotype', 'Comments'
        ]
        req.fieldSelection = [
          'project_identifier', 'contributing_institution', 'sample_identifier',
          'host_identifier', 'host_type', 'host_species', 'host_common_name', 'host_sex', 'host_age', 'host_age_group', 'host_health',
          'collection_country', 'collection_state', 'collection_city', 'collection_date', 'collection_year',
          'test_type', 'test_result', 'test_interpretation', 'serotype', 'comments'
        ]
        break
      case 'sp_gene':
        req.fieldHeader = [
          'Evidence', 'Property', 'Source', 'Genome Name', 'BRC ID', 'RefSeq Locus Tag', 'Alt Locus Tag', 'Source ID',
          'Source Organism', 'Gene', 'Product', 'Function', 'Classification', 'PubMed', 'Subject Coverage', 'Query Coverage',
          'Identity', 'E-value'
        ]
        req.fieldSelection = [
          'evidence', 'property', 'source', 'genome_name', 'patric_id', 'refseq_locus_tag', 'alt_locus_tag', 'source_id',
          'organism', 'gene', 'product', 'function', 'classification', 'pmid', 'subject_coverage', 'query_coverage', 'identity',
          'e_value'
        ]
        break
      case 'sp_gene_ref':
        req.fieldHeader = [
          'Property', 'Source', 'Source ID', 'Gene', 'Organism', 'Locus Tag', 'Gene ID', 'GI', 'Product',
          'Function', 'Classification', 'PubMed'
        ]
        req.fieldSelection = [
          'property', 'source', 'source_id', 'gene_name', 'organism', 'locus_tag', 'gene_id', 'gi', 'product',
          'function', 'classification', 'pmid'
        ]
        break
      case 'spike_lineage':
        req.fieldHeader = [
          'Covariant', 'Loc', 'Sequence Features', 'Country', 'Region', 'Month', 'Total Sequences', 'Covariant Sequences', 'Frequency', 'Growth Rate'
        ]
        req.fieldSelection = [
          'lineage', 'lineage_of_concern', 'sequence_features', 'country', 'region', 'month', 'total_isolates', 'lineage_count', 'prevalence', 'growth_rate'
        ]
        break
      case 'spike_variant':
        req.fieldHeader = [
          'Variant', 'Sequence Features', 'Country', 'Region', 'Month', 'Total Sequences', 'Variant Sequences', 'Frequency', 'Growth Rate'
        ]
        req.fieldSelection = [
          'aa_variant', 'sequence_features', 'country', 'region', 'month', 'total_isolates', 'lineage_count', 'prevalence', 'growth_rate'
        ]
        break
      case 'transcriptomics_experiment':
        req.fieldHeader = [
          'Experiment ID', 'Title', 'Comparisons', 'Genes', 'PubMed', 'Accession', 'Organism', 'Strain',
          'Gene Modification', 'Experimental Condition', 'Time Series', 'Release Date', 'Author', 'PI', 'Institution'
        ]
        req.fieldSelection = [
          'eid', 'title', 'samples', 'genes', 'pmid', 'accession', 'organism', 'strain', 'mutant',
          'condition', 'timeseries', 'release_date', 'author', 'pi', 'institution'
        ]
        break
      case 'transcriptomics_sample':
        req.fieldHeader = [
          'Experiment ID', 'Comparison ID', 'Title', 'Genes', 'Significant genes(Log Ratio)',
          'Significant genes(Z Score)', 'PubMed', 'Accession', 'Organism', 'Strain', 'Gene Modification', 'Experiment Condition',
          'Time Point', 'Release Date'
        ]
        req.fieldSelection = [
          'eid', 'pid', 'expname', 'genes', 'sig_log_ratio', 'sig_z_score', 'pmid', 'accession',
          'organism', 'strain', 'mutant', 'condition', 'timepoint', 'release_date'
        ]
        break
      case 'experiment':
        req.fieldHeader = [
          'Experiment ID', 'Study Name', 'Study Title', 'Experiment Name', 'Experiment Title', 'Public Identifier', 'Experiment Type', 'Organism', 'Strain',
          'Treatment Type', 'Treatment Name', 'Treatment Amount', 'Treatment Duration', 'Biosets'
        ]
        req.fieldSelection = [
          'exp_id', 'study_name', 'study_title', 'exp_name', 'exp_title', 'public_identifier', 'exp_type', 'organism', 'strain',
          'treatment_type', 'treatment_name', 'treatment_amount', 'treatment_duration', 'biosets'
        ]
        break
      case 'bioset':
        req.fieldHeader = [
          'Experiment ID', 'Study Name', 'Study Title', 'Experiment Name', 'Experiment Title', 'Experiment Type', 'Bioset Name', 'Bioset Description', 'Bioset Type', 'Organism', 'Strain',
          'Treatment Type', 'Treatment Name', 'Treatment Amount', 'Treatment Duration', 'Result Count'
        ]
        req.fieldSelection = [
          'exp_id', 'study_name', 'study_title', 'exp_name', 'exp_title', 'exp_type', 'bioset_name', 'bioset_description', 'bioset_type', 'organism', 'strain',
          'treatment_type', 'treatment_name', 'treatment_amount', 'treatment_duration', 'entity_count'
        ]

        break
      case 'interaction':
      case 'ppi':
        req.fieldHeader = [
          'Interactor A ID', 'Interactor A Type', 'Interactor A Desc',
          'Domain A', 'Taxon ID A', 'Genome ID A', 'Genome Name A', 'RefSeq Locus Tag A', 'gene A',
          'Interactor B ID', 'Interactor B Type', 'Interactor B Desc',
          'Domain B', 'Taxon ID B', 'Genome ID B', 'Genome Name B', 'RefSeq Locus Tag B', 'gene B',
          'Category', 'Interaction Type', 'Detection Method', 'Evidence',
          'PMID', 'Source DB', 'Source ID', 'Score'
        ]
        req.fieldSelection = [
          'interactor_a', 'interactor_type_a', 'interactor_desc_a',
          'domain_a', 'taxon_id_a', 'genome_id_a', 'genome_name_a', 'refseq_locus_tag_a', 'gene_a',
          'interactor_b', 'interactor_type_b', 'interactor_desc_b',
          'domain_b', 'taxon_id_b', 'genome_id_b', 'genome_name_b', 'refseq_locus_tag_b', 'gene_b',
          'category', 'interaction_type', 'detection_method', 'evidence',
          'pmid', 'source_db', 'source_id', 'score'
        ]
        break
      default:
        break
    }
  }

  next()
}
