/**
 * JoinEnrichment Middleware
 *
 * Enriches paginated query results with fields from related collections.
 * Joins are only performed when the client explicitly requests joinable fields
 * via the select() RQL function or fl= Solr parameter.
 *
 * This provides the same enrichment capability as GenomeMetadataJoinStream
 * but for paginated (non-streaming) queries.
 *
 * Insert this middleware after APIMethodHandler/ContentRange and before media.
 */

const debug = require('debug')('p3api-server:middleware/JoinEnrichment')
const Config = require('../config')
const BatchJoiner = require('../lib/BatchJoiner')
const { getRequestedJoinFields } = require('../lib/parseFieldList')

// Singleton BatchJoiner instance (lazy initialized)
let batchJoiner = null
let joinerInitPromise = null

/**
 * Get or create the BatchJoiner singleton.
 * Requires the distributed query infrastructure for DirectSolrClient.
 *
 * @returns {Promise<BatchJoiner>}
 */
async function getJoiner () {
  if (batchJoiner) {
    return batchJoiner
  }

  if (joinerInitPromise) {
    return joinerInitPromise
  }

  joinerInitPromise = (async () => {
    const SolrClusterClient = require('../lib/distributed/SolrClusterClient')
    const DirectSolrClient = require('../lib/distributed/DirectSolrClient')
    const { getConfig: getDistributedConfig } = require('../lib/distributed/DistributedQueryConfig')
    const https = require('https')
    const fs = require('fs')

    const solrUrl = Config.get('solr').url
    const joinConfig = getJoinConfig()
    const distributedConfig = getDistributedConfig()

    // Build SSL/TLS options from distributed query config
    const tlsOptions = {}
    if (distributedConfig.ca) {
      if (distributedConfig.ca.startsWith('/') || distributedConfig.ca.startsWith('./')) {
        try {
          tlsOptions.ca = fs.readFileSync(distributedConfig.ca)
          debug(`Loaded CA certificate from: ${distributedConfig.ca}`)
        } catch (err) {
          debug(`Warning: Could not read CA file ${distributedConfig.ca}: ${err.message}`)
        }
      } else {
        tlsOptions.ca = distributedConfig.ca
      }
    }
    if (distributedConfig.rejectUnauthorized === false) {
      tlsOptions.rejectUnauthorized = false
      debug('SSL certificate validation disabled')
    }

    // Create HTTPS agent with TLS options if using HTTPS
    let agent = null
    if (solrUrl.startsWith('https:')) {
      agent = new https.Agent({
        keepAlive: true,
        maxSockets: 10,
        ...tlsOptions
      })
    }

    // Create cluster client with agent
    const clusterClient = new SolrClusterClient(solrUrl, { agent })

    // Create direct Solr client for batch lookups
    const directClient = new DirectSolrClient(clusterClient, { agent })

    // Create BatchJoiner with configured cache size
    batchJoiner = new BatchJoiner(directClient, {
      cacheSize: joinConfig.cacheSize || 200
    })

    debug('BatchJoiner initialized')
    return batchJoiner
  })()

  return joinerInitPromise
}

/**
 * Get join configuration from config.
 *
 * @returns {Object} Join enrichment configuration
 */
function getJoinConfig () {
  const defaults = {
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

  // Merge with config file settings
  const configuredJoin = Config.get('joinEnrichment')
  if (configuredJoin) {
    return {
      ...defaults,
      ...configuredJoin,
      collections: {
        ...defaults.collections,
        ...(configuredJoin.collections || {})
      }
    }
  }

  return defaults
}

/**
 * Build join specifications from requested fields and collection config.
 *
 * Groups fields by their target collection to minimize lookups.
 *
 * @param {Array<string>} requestedJoinFields - Field names that were requested
 * @param {Object} joinableFields - Collection's joinable field configuration
 * @returns {Array<Object>} Array of join specifications, grouped by target collection
 */
function buildJoinSpecs (requestedJoinFields, joinableFields) {
  // Group by target collection and local field
  const groups = new Map()

  for (const fieldName of requestedJoinFields) {
    const fieldConfig = joinableFields[fieldName]
    if (!fieldConfig) continue

    // Create a key for grouping: targetCollection + localField
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

  return Array.from(groups.values())
}

/**
 * JoinEnrichment Middleware
 *
 * Enriches query results with joined fields when explicitly requested.
 */
async function joinEnrichmentMiddleware (req, res, next) {
  // Only process query method with docs
  if (req.call_method !== 'query') {
    return next()
  }

  // Check if we have response docs to enrich
  if (!res.results?.response?.docs?.length) {
    return next()
  }

  // Get join configuration
  const config = getJoinConfig()

  // Check if join enrichment is enabled
  if (!config.enabled) {
    return next()
  }

  // Get collection-specific config
  const collectionConfig = config.collections[req.call_collection]
  if (!collectionConfig || !collectionConfig.joinableFields) {
    return next()
  }

  // Parse requested fields from the query
  const query = req.call_params[0] || ''
  const requestedJoinFields = getRequestedJoinFields(query, collectionConfig.joinableFields)

  if (requestedJoinFields.length === 0) {
    debug(`No join fields requested for ${req.call_collection}`)
    return next()
  }

  debug(`Join fields requested for ${req.call_collection}: ${requestedJoinFields.join(', ')}`)

  try {
    // Build join specifications
    const joinSpecs = buildJoinSpecs(requestedJoinFields, collectionConfig.joinableFields)

    if (joinSpecs.length === 0) {
      return next()
    }

    // Get or create the BatchJoiner
    const joiner = await getJoiner()

    // Perform enrichment for each join spec
    const startTime = Date.now()

    for (const joinSpec of joinSpecs) {
      debug(`Enriching with ${joinSpec.fields.join(',')} from ${joinSpec.targetCollection} via ${joinSpec.localField}`)
      await joiner.enrichDocs(res.results.response.docs, joinSpec)
    }

    const elapsed = Date.now() - startTime
    debug(`Join enrichment completed in ${elapsed}ms for ${res.results.response.docs.length} docs`)

    // Add header to indicate join was performed
    res.set('X-Join-Enrichment', 'true')
    res.set('X-Join-Fields', requestedJoinFields.join(','))
    res.set('X-Join-Time-Ms', String(elapsed))

    next()
  } catch (err) {
    // Log error but don't fail the request - return unenriched results
    console.error(`JoinEnrichment error for ${req.call_collection}: ${err.message}`)
    debug(`JoinEnrichment error: ${err.stack}`)

    // Set header to indicate join was attempted but failed
    res.set('X-Join-Enrichment', 'error')
    res.set('X-Join-Error', err.message.substring(0, 100))

    next()
  }
}

// Export the middleware
module.exports = joinEnrichmentMiddleware

// Export for testing
module.exports.getJoinConfig = getJoinConfig
module.exports.buildJoinSpecs = buildJoinSpecs
module.exports.getJoiner = getJoiner
