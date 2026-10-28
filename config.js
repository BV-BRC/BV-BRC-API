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
    // Private per-genome metadata. Uses the standard owner/user_read/user_write/public
    // triple, so DecorateQuery + lib/permissionFilter scope it with no special handling.
    // Deliberately NOT in publicFree (middleware/PublicDataTypes.js) and deliberately NOT
    // in genomeCoresUUIDs (routes/genomePermissionRouter.js) — see the note there.
    'private_genome_metadata',
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

  /*
   * Origins permitted to make *credentialed* cross-origin requests. Anonymous
   * cross-origin reads remain open to everyone -- this is a public data API.
   * See util/corsOptions.js.
   *
   * Exact-match serialized origins, enumerated explicitly: BV-BRC uses
   * alpha./beta./dev-N. while the sibling properties use dev./test., so no
   * interpolation over a property name is correct for all of them. This is
   * the same list the OAuth2 redirect_uri registration needs; keep them in
   * sync (PLAN-oauth2-migration.md, "Multi-Domain Rollout and CORS").
   *
   * Empty by default: the deployment places site-facing endpoints under the
   * site's own registrable domain, so production traffic is same-origin and
   * needs no entry here. Set it in p3api.conf only for a property that must
   * genuinely make credentialed cross-origin calls.
   */
  cors_origins: [],

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

  // Outbound email (nodemailer). Production SMTP host/username/password live in
  // p3api.conf; these are safe local defaults. localSendmail:true uses the local
  // MTA instead of an SMTP relay. indexAlertTo/indexMaxAttempts drive the index
  // worker's transient-error retry alerting (see bin/p3-index-worker-once).
  email: {
    localSendmail: false,
    defaultFrom: 'BV-BRC <do-not-reply@bv-brc.org>',
    host: 'localhost',
    port: 25,
    indexAlertTo: 'bvbrc-admin@lists.cels.anl.gov',
    indexMaxAttempts: 30
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
    // uniqueKey is a UUID, not genome_id — one genome may carry several metadata
    // records (verified against the live schema).
    private_genome_metadata: 'id',
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

  // Layer 1 admission control. See lib/SolrAdmissionControl.js and
  // Docs/ADMISSION_CONTROL_STATUS-2026-10.md.
  //
  // DISABLED BY DEFAULT, deliberately. Enabling it makes the API return 429, which needs
  // coordinated client updates first (CLI tools and the website must honour Retry-After
  // without tight-retrying). Until then the middleware still classifies every request and
  // reports pool state at /stats, so a dry run shows what *would* have been shed.
  //
  // Pool sizes are per worker, so cluster-facing concurrency is size x worker count.
  // The rule they are chosen against is "admission pool <= socket pool, so the socket
  // queue stays empty" — heavy at 3 against the main Solr agent's maxSockets 8.
  queryAdmission: {
    enabled: false,
    heavyMaxConcurrent: 3,
    heavyMaxQueue: 6,
    heavyMaxWaitMs: 10000,
    interactiveMaxConcurrent: 20,
    interactiveMaxQueue: 20,
    interactiveMaxWaitMs: 1000
  },

  // Cross-collection join admission. See lib/joinResolver.js and
  // Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md.
  //
  // Thresholds are genome counts, and they were calibrated against the measured cost
  // curve on 2026-10-12 — re-measure before changing them, because the corpus grows:
  // Bacteria was ~500K when the original plan was written and is 1.38M now.
  //
  //   <= rewriteMaxGenomes  resolve locally to {!terms} (3-6x faster, identical results)
  //   <= rejectMaxGenomes   leave the join alone
  //    > rejectMaxGenomes   refuse with 400 — this is the OOM guard
  joinResolution: {
    enabled: true,
    rewriteMaxGenomes: 50000,
    rejectMaxGenomes: 150000,
    countCacheTtlMs: 300000,
    idCacheTtlMs: 300000,
    cacheMaxEntries: 200,

    // Taxon-subtree rewrite: express a purely taxonomic join as
    //   fq={!terms f=taxon_id}<subtree>  &  fq=-{!terms f=genome_id}<deprecated>
    // rather than resolving it to a live genome_id list, which does not scale past
    // ~50,000 genomes. Measured 1,770ms against the join's 25,097ms on E. coli with
    // identical numFound, and it answers Influenza A in ~9.8s where the join cannot
    // complete at all. OFF by default: it changes which query a broad taxon runs and
    // wants shaking down on alpha first.
    // See Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md §4.1a.
    taxonomicRewrite: false,

    // Let a BULK DOWNLOAD whose join exceeds rejectMaxGenomes stream anyway, resolving
    // the join in bounded slices instead of one oversized {!terms} filter. Grid pages
    // are still refused -- a page must be fast or fail fast -- but a download is already
    // a long operation, and slow-but-reliable beats a 400. ~5 min of Solr time for
    // Viruses (14.9M genomes), with memory and request bodies bounded throughout.
    // See lib/BatchedJoinStream.js. OFF by default: it turns a fast refusal into a long
    // response, which is a deliberate operational choice.
    batchedDownloads: false,

    // Fill /data/summary_by_taxon by slicing the genome set and summing per-slice facets
    // when the join is refused. Facet counts are additive over disjoint slices, and
    // slicing measured ~10x CHEAPER than the join (5s vs 52s on 246,835 genomes), so this
    // is not merely a survivable fallback. Taxon 10239 previously spent 600s here and
    // returned a 500. Behind cacheWithRedis('1 day'), so the cost is paid once per day.
    // OFF by default: a fast 400 becoming a multi-minute fill is an operational choice.
    slicedSummary: false,
    // Caps on the two lookups. Exceeding either abandons the rewrite and leaves the join
    // intact -- emitting the subtree WITHOUT its exclusion would silently over-count.
    exclusionMaxIds: 400000,
    subtreeMaxTaxa: 250000
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
