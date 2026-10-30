/**
 * Join Configuration — shared by JoinFieldInjector and JoinEnrichment
 *
 * Phase 2a of PLAN_CROSS_COLLECTION_DOWNLOAD.md.
 *
 * `getJoinConfig()` and `buildJoinSpecs()` were previously duplicated verbatim in
 * middleware/JoinFieldInjector.js and middleware/JoinEnrichment.js (the source
 * comment cited "circular dependencies" as the reason). That was tolerable while
 * both copies only understood single-hop joins. It stops being tolerable with
 * multi-hop `path` specs: the injector decides which key to inject into `fl=` and
 * the enricher decides how to walk the hops, so a grammar implemented twice will
 * drift, and the failure mode is a silently unenriched field.
 *
 * Both middleware now import this module. There is no circular dependency: this
 * module depends only on ../config.
 */

const debug = require('debug')('p3api-server:join-config')
const Config = require('../config')

/**
 * Genome metadata available for enrichment on every genome-keyed collection.
 *
 * All of these live on `genome` and are reached by `genome_id`, so `buildJoinSpecs`
 * groups them into ONE lookup however many a client requests — the count here does not
 * multiply queries. `fl` is built from the REQUESTED fields only (BatchJoiner
 * `_fetchAndCache`), so defining a field costs nothing until somebody selects it.
 *
 * DEPRECATED FIELDS ARE DELIBERATELY ABSENT. The genome schema marks `isolation_site`,
 * `latitude`, `longitude`, `altitude`, `depth`, `body_sample_site`,
 * `body_sample_subsite`, `antimicrobial_resistance` and
 * `antimicrobial_resistance_evidence` deprecated; exposing them here would advertise
 * them as current and grow a surface we intend to shrink. `collection_date_dr` is also
 * absent — it is `stored="false"`, so Solr cannot return it.
 *
 * Adding a field: confirm it is `stored="true"` on `genome`, then add one line. There is
 * no per-field cost to the common path.
 */
const GENOME_METADATA_FIELDS = [
  // Identity and assembly status. These were originally per-collection entries on
  // genome_feature only; they belong in the shared set like everything else, so that
  // a client selecting `strain` on sp_gene does not have to know which collection
  // happened to be wired up first.
  'strain', 'genome_status',
  // Isolation and collection
  'isolation_source', 'isolation_comments', 'collection_date', 'collection_year', 'season',
  // Geography
  'isolation_country', 'state_province', 'county', 'city',
  'geographic_group', 'geographic_location', 'other_environmental',
  // Host
  'host_name', 'host_common_name', 'host_scientific_name', 'host_gender', 'host_age',
  'host_health', 'host_group', 'lab_host', 'passage', 'other_clinical',
  // Phenotype and physiology
  'phenotype', 'gram_stain', 'cell_shape', 'motility', 'sporulation',
  'temperature_range', 'optimal_temperature', 'salinity', 'oxygen_requirement', 'habitat',
  // Disease
  'disease'
]

/** `{ field: { from: 'genome', via: 'genome_id', field } }` for a list of genome fields. */
function genomeFields (names) {
  return names.reduce((acc, name) => {
    acc[name] = { from: 'genome', via: 'genome_id', field: name }
    return acc
  }, {})
}

/**
 * Built-in join configuration. Merged with `joinEnrichment` from p3api.conf,
 * with configured collections overriding these per-collection.
 *
 * Every genome-keyed collection gets the same metadata set — a client selecting
 * `host_name` on `sp_gene` should not have to know it is only wired up for
 * `genome_feature`. The per-collection extras above the shared set are the fields that
 * were already configured before the metadata set was added.
 */
const DEFAULT_JOIN_CONFIG = {
  enabled: true,
  cacheSize: 200,
  collections: {
    genome_feature: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    },
    pathway: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    },
    subsystem: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    },
    sp_gene: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    },
    genome_amr: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    },
    // Contigs carry genome_id, so they join like any other genome-keyed collection.
    // Omitted when the metadata set was added, which showed up as
    // `/genome_sequence/fields` reporting 0 enriched fields while sp_gene reported 33.
    //
    // NOTE `genome` itself is deliberately NOT here: its 145 native fields already
    // include all of this metadata, so a genome->genome self-join would be a no-op and
    // would list every field twice.
    genome_sequence: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        ...genomeFields(GENOME_METADATA_FIELDS)
      }
    }
  }
}

/**
 * Get join configuration, merging p3api.conf's `joinEnrichment` over the defaults.
 *
 * @returns {Object} Join enrichment configuration
 */
function getJoinConfig () {
  const configuredJoin = Config.get('joinEnrichment')

  if (configuredJoin) {
    return {
      ...DEFAULT_JOIN_CONFIG,
      ...configuredJoin,
      collections: {
        ...DEFAULT_JOIN_CONFIG.collections,
        ...(configuredJoin.collections || {})
      }
    }
  }

  return DEFAULT_JOIN_CONFIG
}

/**
 * Is this field config a multi-hop (`path`) spec?
 *
 * @param {Object} fieldConfig - A joinableFields entry
 * @returns {boolean}
 */
function isChainedField (fieldConfig) {
  return !!(fieldConfig && Array.isArray(fieldConfig.path) && fieldConfig.path.length > 0)
}

/**
 * Build join specifications from requested fields and collection config.
 *
 * Single-hop fields are grouped by (targetCollection, localField) so that several
 * fields coming from the same collection cost one lookup. Multi-hop fields cannot
 * be grouped that way — each is its own chain — so they are returned as separate
 * chained specs.
 *
 * @param {Array<string>} requestedJoinFields - Field names that were requested
 * @param {Object} joinableFields - Collection's joinable field configuration
 * @returns {Array<Object>} Join specifications. Single-hop specs have
 *   { targetCollection, localField, foreignField, fields }; chained specs have
 *   { chained: true, outputField, hops: [...] }.
 */
function buildJoinSpecs (requestedJoinFields, joinableFields) {
  const groups = new Map()
  const specs = []

  for (const fieldName of requestedJoinFields) {
    const fieldConfig = joinableFields[fieldName]
    if (!fieldConfig) continue

    if (isChainedField(fieldConfig)) {
      const chained = buildChainedSpec(fieldName, fieldConfig)
      if (chained) specs.push(chained)
      continue
    }

    // Single-hop: group by target collection + local field to minimize lookups.
    const groupKey = `${fieldConfig.from}:${fieldConfig.via}`

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        targetCollection: fieldConfig.from,
        localField: fieldConfig.via,
        foreignField: fieldConfig.via, // Typically same field name on both sides
        fields: []
      })
    }

    groups.get(groupKey).fields.push(fieldConfig.field)
  }

  return [...groups.values(), ...specs]
}

/**
 * Normalize a `path` field config into a chained join spec.
 *
 * Each hop: `foreignField` is matched against the incoming `localField`; `carry`
 * names the field pulled forward to key the next hop; the final hop's `field` is
 * what gets attached to the document (under `outputField`).
 *
 * @param {string} fieldName - The client-facing field name (e.g. 'aa_sequence')
 * @param {Object} fieldConfig - Config entry containing `path`
 * @returns {Object|null} Chained spec, or null if the path is malformed
 */
function buildChainedSpec (fieldName, fieldConfig) {
  const hops = []

  for (let i = 0; i < fieldConfig.path.length; i++) {
    const hop = fieldConfig.path[i]
    const isLast = i === fieldConfig.path.length - 1

    if (!hop.from || !hop.localField || !hop.foreignField) {
      debug(`Malformed hop ${i} in join path for '${fieldName}': needs from/localField/foreignField`)
      return null
    }

    // Intermediate hops must carry a value forward; the last hop must produce one.
    if (!isLast && !hop.carry) {
      debug(`Malformed hop ${i} in join path for '${fieldName}': intermediate hop needs 'carry'`)
      return null
    }
    if (isLast && !hop.field) {
      debug(`Malformed final hop in join path for '${fieldName}': needs 'field'`)
      return null
    }

    hops.push({
      targetCollection: hop.from,
      localField: hop.localField,
      foreignField: hop.foreignField,
      carry: hop.carry || null,
      field: hop.field || null
    })
  }

  return {
    chained: true,
    outputField: fieldConfig.as || fieldName,
    hops
  }
}

/**
 * Get the set of local key fields that must exist on the primary documents for
 * the requested joins to work. These get injected into `fl=` by JoinFieldInjector.
 *
 * For a chained field this is the FIRST hop's localField — the later hops are keyed
 * by values carried forward from earlier fetches, not by fields on the source doc.
 *
 * @param {Array<string>} requestedJoinFields - Requested join field names
 * @param {Object} joinableFields - Collection's joinable field configuration
 * @returns {Set<string>} Key field names to ensure are selected
 */
function getRequiredJoinKeys (requestedJoinFields, joinableFields) {
  const keys = new Set()

  for (const fieldName of requestedJoinFields) {
    const fieldConfig = joinableFields[fieldName]
    if (!fieldConfig) continue

    if (isChainedField(fieldConfig)) {
      const first = fieldConfig.path[0]
      if (first && first.localField) {
        keys.add(first.localField)
      }
      continue
    }

    if (fieldConfig.via) {
      keys.add(fieldConfig.via)
    }
  }

  return keys
}

module.exports = {
  getJoinConfig,
  GENOME_METADATA_FIELDS,
  buildJoinSpecs,
  buildChainedSpec,
  getRequiredJoinKeys,
  isChainedField,
  DEFAULT_JOIN_CONFIG
}
