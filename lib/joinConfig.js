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
 * Built-in join configuration. Merged with `joinEnrichment` from p3api.conf,
 * with configured collections overriding these per-collection.
 */
const DEFAULT_JOIN_CONFIG = {
  enabled: true,
  cacheSize: 200,
  collections: {
    genome_feature: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' },
        genome_status: { from: 'genome', via: 'genome_id', field: 'genome_status' },
        strain: { from: 'genome', via: 'genome_id', field: 'strain' }
      }
    },
    pathway: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
      }
    },
    subsystem: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
      }
    },
    sp_gene: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
      }
    },
    genome_amr: {
      joinableFields: {
        genome_name: { from: 'genome', via: 'genome_id', field: 'genome_name' },
        taxon_id: { from: 'genome', via: 'genome_id', field: 'taxon_id' }
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
  buildJoinSpecs,
  buildChainedSpec,
  getRequiredJoinKeys,
  isChainedField,
  DEFAULT_JOIN_CONFIG
}
