var nconf = require('nconf')

var defaults = {
  'http_port': 3001,

  collections: [
    'antibiotics',
    'enzyme_class_ref',
    'gene_ontology_ref',
    'genome',
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
    'structured_assertion',
    'subsystem',
    'subsystem_ref',
    'taxonomy',
    'transcriptomics_experiment',
    'transcriptomics_gene',
    'transcriptomics_sample',
    'proteomics_experiment',
    'proteomics_peptide',
    'proteomics_protein'
  ],

  enableIndexer: false,
  indexImportLimits: {
    default: 25,
    genome_sequence: 100
  },

  distributeURL: 'http://localhost:3001/',

  jbrowseAPIRoot: 'http://localhost:3001/jbrowse',

  treeDirectory: './trees',
  contentDirectory: './content',
  publicGenomeDir: '/genomes',
  queueDirectory: './index-queue-dir',
  'solr': {
    'url': 'http://localhost:8983/solr'
    , agent: {
      keepAlive: true,
      maxSockets: 32,
      keepAliveMsecs: 3000
    }
    , shortLiveAgent: {
      keepAlive: true,
      maxSockets: 8
    }
  },

  'redis': {
    'host': '127.0.0.1',
    'port': 6379,
    'prefix': '',
    'db': 2,
    'pass': ''
  },

  'numWorkers': 0,

  'cache': {
    'enabled': false,
    'directory': '/tmp/p3api_cache'
  }

}

module.exports = nconf.argv().env().file('./p3api.conf').defaults(defaults)
