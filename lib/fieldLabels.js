/**
 * Human-readable labels for Solr field names.
 *
 * THERE IS NO AUTHORITATIVE LABEL SOURCE IN THIS CODEBASE. That is worth stating plainly,
 * because it looks like there should be:
 *
 *   - Solr's schema carries `name`/`type`/`indexed`/`stored` and nothing else. Display
 *     metadata cannot live there — adding an `x-display-*` property makes core creation
 *     fail outright (`Invalid field property: x-display-default`; see NOTES.md, which
 *     proposes a master-schema document precisely because of this).
 *   - `middleware/ExtractCustomFields.js` holds parallel `fieldHeader`/`fieldSelection`
 *     arrays per collection, but they exist to title download columns, not to describe
 *     fields. They cover 20 collections but NOT `pathway` or `subsystem`, and of the 33
 *     genome metadata fields they label exactly zero.
 *
 * So labels here are DERIVED from the field name, with an override table for the cases
 * where derivation reads badly. That is deliberate: a complete hand-maintained table of
 * ~150 fields per collection would be stale within a release, whereas derivation is
 * always at least reasonable and the override table only has to carry the exceptions.
 *
 * If a curated label set ever lands (the master-schema document in NOTES.md is the
 * natural home), this module is the single place to read it from.
 */

/**
 * Field names whose derived label is wrong, misleading, or merely ugly.
 *
 * Keep this SMALL. Every entry is a maintenance burden; add one only when the derived
 * form is actually unacceptable, not merely different from a preference.
 */
const LABEL_OVERRIDES = {
  // Initialisms and domain terms that title-casing mangles.
  genome_id: 'Genome ID',
  taxon_id: 'Taxon ID',
  feature_id: 'Feature ID',
  patric_id: 'BRC ID',
  pdb_id: 'PDB ID',
  pmid: 'PubMed ID',
  gi: 'GI Number',
  refseq_locus_tag: 'RefSeq Locus Tag',
  protein_id: 'Protein ID',
  aa_sequence_md5: 'AA Sequence MD5',
  na_sequence_md5: 'NA Sequence MD5',
  sequence_md5: 'Sequence MD5',
  p2_feature_id: 'P2 Feature ID',
  pgfam_id: 'PGFam ID',
  plfam_id: 'PLFam ID',
  figfam_id: 'FIGFam ID',
  ec_number: 'EC Number',
  go_id: 'GO ID',
  uniprotkb_accession: 'UniProtKB Accession',
  rna_type: 'RNA Type',
  gc_content: 'GC Content',
  cds: 'CDS',
  cds_ratio: 'CDS Ratio',
  patric_cds: 'BRC CDS',
  refseq_cds: 'RefSeq CDS',
  hypothetical_cds: 'Hypothetical CDS',
  hypothetical_cds_ratio: 'Hypothetical CDS Ratio',
  partial_cds: 'Partial CDS',
  partial_cds_ratio: 'Partial CDS Ratio',
  plfam_cds_ratio: 'PLFam CDS Ratio',
  trna: 'tRNA',
  rrna: 'rRNA',
  contig_l50: 'Contig L50',
  contig_n50: 'Contig N50',
  bioproject_accession: 'BioProject Accession',
  biosample_accession: 'BioSample Accession',
  genbank_accessions: 'GenBank Accessions',
  sra_accession: 'SRA Accession',
  // Reads better than the derived form.
  owner: 'Owner',
  public: 'Public',
  date_inserted: 'Date Inserted',
  date_modified: 'Date Modified',
  collection_date: 'Collection Date',
  collection_year: 'Collection Year',
  other_clinical: 'Other Clinical',
  other_environmental: 'Other Environmental'
}

/**
 * Derive a label from a field name: `host_common_name` -> `Host Common Name`.
 *
 * @param {string} name
 * @returns {string}
 */
function deriveLabel (name) {
  if (!name || typeof name !== 'string') return ''
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Human-readable label for a field.
 *
 * @param {string} name - Solr field name
 * @returns {string}
 */
function fieldLabel (name) {
  if (!name || typeof name !== 'string') return ''
  return LABEL_OVERRIDES[name] || deriveLabel(name)
}

module.exports = {
  fieldLabel,
  deriveLabel,
  LABEL_OVERRIDES
}
