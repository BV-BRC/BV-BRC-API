
const publicFree = ['antibiotics', 'enzyme_class_ref', 'gene_ontology_ref', 'id_ref', 'misc_niaid_sgc', 'pathway_ref', 'ppi', 'pig', 'protein_family_ref', 'sp_gene_evidence', 'sp_gene_ref', 'spike_lineage', 'spike_variant', 'subsystem_ref', 'taxonomy', 'transcriptomics_experiment', 'transcriptomics_gene', 'transcriptomics_sample', 'model_reaction', 'model_complex_role', 'model_compound', 'model_template_biomass', 'model_template_reaction', 'feature_sequence', 'protein_structure', 'protein_feature', 'surveillance']

module.exports = function (req, res, next) {
  req.publicFree = publicFree
  next()
}
