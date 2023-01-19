const nconf = require('nconf')

const defaults = {
  http_port: 3001,

  collections: [
    'antibiotics',
    'enzyme_class_ref',
    'epitope',
    'epitope_assay',
    'experiment',
    'bioset',
    'bioset_result',
    'gene_ontology_ref',
    'genome',
    'strain',
    'genome_test',
    'genome_amr',
    'feature_sequence',
    'genome_feature',
    'genome_sequence',
    'host_resp',
    'id_ref',
    'misc_niaid_sgc',
    'model_complex_role',
    'model_compound',
    'model_reaction',
    'model_template_biomass',
    'model_template_reaction',
    'pathway',
    'pathway_ref',
    'ppi',
    'pig',
    'protein_family_ref',
    'sp_gene',
    'sp_gene_evidence',
    'sp_gene_ref',
    'spike_lineage',
    'spike_variant',
    'structured_assertion',
    'subsystem',
    'subsystem_ref',
    'taxonomy',
    'transcriptomics_experiment',
    'transcriptomics_gene',
    'transcriptomics_sample',
    'protein_structure',
    'protein_feature',
    'surveillance',
    'serology',
    'proteomics_experiment',
    'proteomics_peptide',
    'proteomics_protein'
  ],

  distributeURL: 'http://localhost:3001/',
  publicURL: 'http://localhost:3001/',

  jbrowseAPIRoot: 'http://localhost:3001/jbrowse',

  treeDirectory: './trees',
  contentDirectory: './content',
  publicGenomeDir: '/genomes',
  queueDirectory: './index-queue-dir',
  signingSubjectURL: 'https://user.patricbrc.org/public_key',
  solr: {
    url: 'http://localhost:8983/solr',
    agent: {
      keepAlive: true,
      maxSockets: 8,
      maxFreeScokets: 0,
      keepAliveMsecs: 1000
    },
    shortLiveAgent: {
      keepAlive: true,
      maxSockets: 4,
      maxFreeScokets: 0,
      keepAliveMsecs: 500
    }
  },

  redis: {
    host: '127.0.0.1',
    port: 6379,
    prefix: '',
    db: 2,
    pass: ''
  },

  shards: {
    genome_feature: {
      preference: 'replica.type:PULL,replica.type:TLOG'
    },
    pathway: {
      preference: 'replica.type:PULL,replica.type:TLOG'
    },
    subsystem: {
      preference: 'replica.type:PULL,replica.type:TLOG'
    }
  }

}

module.exports = nconf.argv().env().file(process.env.P3_API_CONFIG || './p3api.conf').defaults(defaults)
