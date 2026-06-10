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
    'genome_typing',
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
    'sequence_feature',
    'sequence_feature_vt',
    'sp_gene',
    'sp_gene_ref',
    'spike_lineage',
    'spike_variant',
    'structured_assertion',
    'subsystem',
    'subsystem_ref',
    'taxonomy',
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

  collectionUniqueKeys: {
    antibiotics: 'pubchem_cid',
    bioset: 'bioset_id',
    bioset_result: 'id',
    enzyme_class_ref: 'ec_number',
    epitope: 'epitope_id',
    epitope_assay: 'assay_id',
    experiment: 'exp_id',
    feature_sequence: 'md5',
    gene_ontology_ref: 'go_id',
    genome: 'genome_id',
    genome_amr: 'id',
    genome_feature: 'feature_id',
    genome_sequence: 'sequence_id',
    genome_test: 'genome_id',
    genome_typing: 'id',
    id_ref: 'id',
    misc_niaid_sgc: 'target_id',
    pathway: 'id',
    pathway_ref: 'id',
    ppi: 'id',
    protein_family_ref: 'family_id',
    protein_feature: 'id',
    protein_structure: 'pdb_id',
    sequence_feature: 'id',
    sequence_feature_vt: 'id',
    serology: 'id',
    sp_gene: 'id',
    sp_gene_ref: 'id',
    spike_lineage: 'id',
    spike_variant: 'id',
    strain: 'id',
    structured_assertion: 'id',
    subsystem: 'id',
    subsystem_ref: 'id',
    surveillance: 'id',
    taxonomy: 'taxon_id'
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
  },

  distributedQuery: {
    // Integration settings - controls when distributed queries are used
    enabled: true,
    minLimitThreshold: 10000,
    enabledCollections: ['genome_feature'], // Start with just genome_feature
    disabledCollections: [],
    exposeMetadataHeaders: true,

    // Maximum concurrent shard queries
    maxParallelism: 8,

    // Retry configuration
    maxRetries: 3,
    initialRetryDelayMs: 100,

    // Cache TTLs
    schemaCacheTTLMinutes: 60,
    clusterStatusCacheTTLSeconds: 60,

    // Memory limits
    maxMergeSortHeapDocs: 10000,
    maxMemoryMB: 32,

    // Batch size for cursor pagination
    cursorBatchSize: 2000,

    // Node exclusion patterns (regex strings)
    excludeNodes: [],

    // Admin users who can modify runtime config
    adminUsers: []
  },

  // Join enrichment for paginated queries
  // Adds fields from related collections when explicitly requested via select()
  joinEnrichment: {
    enabled: true,
    cacheSize: 200, // LRU cache size per target collection
    collections: {
      // genome_feature can fetch genome metadata
      genome_feature: {
        joinableFields: {
          genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
          taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
          genome_status: { from: 'genome', via: 'genome_id', field: 'genome_status' },
          strain: { from: 'genome', via: 'genome_id', field: 'strain' }
        }
      },
      // pathway can fetch genome metadata
      pathway: {
        joinableFields: {
          genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
          taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
        }
      },
      // subsystem can fetch genome metadata
      subsystem: {
        joinableFields: {
          genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
          taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
        }
      },
      // sp_gene can fetch genome metadata
      sp_gene: {
        joinableFields: {
          genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
          taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
        }
      },
      // genome_amr can fetch genome metadata
      genome_amr: {
        joinableFields: {
          genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
          taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
        }
      }
    }
  }

}

module.exports = nconf.argv().env().file(process.env.P3_API_CONFIG || './p3api.conf').defaults(defaults)
