/**
 * DNA FASTA Serializer
 *
 * Serializes genome features and genome sequences to DNA FASTA format.
 *
 * Features:
 * - Streaming with proper backpressure handling
 * - Efficient batch sequence lookups via SequenceJoinStream
 * - Optional genome metadata enrichment via GenomeMetadataJoinStream
 * - Configurable FASTA headers via request parameters
 * - Falls back to legacy HTTP-based lookups if direct Solr not available
 *
 * Request parameters for custom headers:
 *   - http_fasta_id_fields: comma-separated fields for ID (e.g., 'patric_id,gene')
 *   - http_fasta_id_delimiter: delimiter between ID fields (default: '|')
 *   - http_fasta_description_fields: comma-separated fields for description
 *   - http_fasta_context_fields: comma-separated fields for [context]
 *
 * Genome metadata fields (when genome join is enabled):
 *   Use 'genome_metadata.field_name' syntax to access genome collection fields.
 *   Available fields: genome_name, taxon_id, genome_status, strain,
 *   assembly_accession, bioproject_accession, biosample_accession
 *
 *   Example: http_fasta_context_fields=genome_metadata.strain,genome_metadata.assembly_accession
 */

const debug = require('debug')('p3api-server:media:dna-fasta')
const LineWrap = require('../util/linewrap')
const { streamWithBackpressure } = require('../util/streamWithBackpressure')
const {
  createFastaHeaderFormatterFromRequest,
  formatLegacyHeader,
  formatLegacyGenomeSequenceHeader
} = require('../util/fastaHeaderFormatter')

// Lazy-loaded dependencies for direct Solr access
// These are optional - we fall back to HTTP if not available
let SequenceJoinStream = null
let GenomeMetadataJoinStream = null
let DirectSolrClient = null
let SolrClusterClient = null
let solrClusterClientInstance = null
let directSolrClientInstance = null

// Legacy imports for fallback mode
const { getSequenceDictByHash } = require('../util/featureSequence')
const SEQUENCE_BATCH = 200

// For genome metadata lookups via HTTP
const axios = require('axios')
const Config = require('../config')

/**
 * Fetch genome metadata via HTTP API.
 * Similar to getSequenceDictByHash but for genome collection.
 *
 * @param {Array<string>} genomeIds - Genome IDs to fetch
 * @param {Object} req - Express request for auth headers
 * @returns {Promise<Object>} Dictionary mapping genome_id to metadata
 */
async function getGenomeMetadataDict (genomeIds, req) {
  if (genomeIds.length === 0) return {}

  const ids = genomeIds.join(',')
  const fields = 'genome_id,genome_name,taxon_id,genome_status,strain,assembly_accession,bioproject_accession,biosample_accession'
  const q = `&in(genome_id,(${ids}))&limit(${genomeIds.length})&select(${fields})`

  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome/'

  try {
    const response = await axios.post(url, q, {
      headers: {
        accept: 'application/json',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      }
    })

    const docs = response.data
    return docs.reduce((h, cur) => {
      h[cur.genome_id] = cur
      return h
    }, {})
  } catch (err) {
    debug(`Failed to fetch genome metadata: ${err.message}`)
    return {}
  }
}

/**
 * Initialize direct Solr clients for efficient sequence lookups.
 * Called lazily on first use.
 */
function initializeDirectSolr () {
  if (directSolrClientInstance) {
    return directSolrClientInstance
  }

  try {
    const Config = require('../config')
    const solrUrl = Config.get('solr').url

    if (!solrUrl) {
      debug('No Solr URL configured, using legacy HTTP mode')
      return null
    }

    // Load distributed query components
    SequenceJoinStream = require('../lib/distributed/SequenceJoinStream')
    GenomeMetadataJoinStream = require('../lib/distributed/GenomeMetadataJoinStream')
    DirectSolrClient = require('../lib/distributed/DirectSolrClient')
    SolrClusterClient = require('../lib/distributed/SolrClusterClient')

    // Get TLS options from distributed query config
    const { getConfig } = require('../lib/distributed/DistributedQueryConfig')
    const distributedConfig = getConfig()
    const https = require('https')
    const fs = require('fs')

    const tlsOptions = {}
    if (distributedConfig.ca) {
      if (distributedConfig.ca.startsWith('/') || distributedConfig.ca.startsWith('./')) {
        try {
          tlsOptions.ca = fs.readFileSync(distributedConfig.ca)
          debug(`Loaded CA certificate from: ${distributedConfig.ca}`)
        } catch (err) {
          debug(`Warning: Could not read CA file: ${err.message}`)
        }
      } else {
        tlsOptions.ca = distributedConfig.ca
      }
    }
    if (distributedConfig.rejectUnauthorized === false) {
      tlsOptions.rejectUnauthorized = false
      debug('SSL certificate validation disabled')
    }

    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 10,
      ...tlsOptions
    })

    // Create cluster client (reuse if exists)
    if (!solrClusterClientInstance) {
      solrClusterClientInstance = new SolrClusterClient(solrUrl, {
        agent: solrUrl.startsWith('https:') ? httpsAgent : undefined
      })
    }

    // Create direct client for sequence lookups
    directSolrClientInstance = new DirectSolrClient(solrClusterClientInstance)

    debug('Direct Solr client initialized for sequence lookups')
    return directSolrClientInstance
  } catch (err) {
    debug(`Failed to initialize direct Solr client: ${err.message}`)
    return null
  }
}

/**
 * Format a single document as FASTA record.
 *
 * @param {Object} doc - Document with sequence attached
 * @param {Function} headerFormatter - Header formatter function
 * @returns {string} Formatted FASTA record
 */
function formatFastaRecord (doc, headerFormatter) {
  const header = headerFormatter(doc)
  const sequence = doc.sequence ? LineWrap(doc.sequence, 60) : ''
  return header + sequence + '\n'
}

/**
 * Format genome sequence document as FASTA record.
 *
 * @param {Object} doc - Genome sequence document
 * @returns {string} Formatted FASTA record
 */
function formatGenomeSequenceRecord (doc) {
  const header = formatLegacyGenomeSequenceHeader(doc)
  const sequence = doc.sequence ? LineWrap(doc.sequence, 60) : ''
  return header + sequence + '\n'
}

/**
 * Check if any FASTA header fields reference genome_metadata.
 *
 * @param {Object} req - Express request object
 * @returns {boolean} True if genome join is needed
 */
function needsGenomeJoin (req) {
  const fastaParams = req.fastaParams || {}
  const fieldsToCheck = [
    fastaParams.http_fasta_id_fields,
    fastaParams.http_fasta_description_fields,
    fastaParams.http_fasta_context_fields
  ]

  return fieldsToCheck.some(fields => {
    return fields && fields.includes('genome_metadata.')
  })
}

/**
 * Check if any FASTA header fields reference genome_metadata.
 *
 * @param {Object} req - Express request object
 * @returns {boolean} True if genome join is needed
 */
function needsGenomeJoin (req) {
  const fastaParams = req.fastaParams || {}
  const fieldsToCheck = [
    fastaParams.http_fasta_id_fields,
    fastaParams.http_fasta_description_fields,
    fastaParams.http_fasta_context_fields
  ]

  return fieldsToCheck.some(fields => {
    return fields && fields.includes('genome_metadata.')
  })
}

/**
 * Serialize genome_feature stream using SequenceJoinStream (new efficient path).
 * Optionally enriches with genome metadata if genome_metadata.* fields are requested.
 */
async function serializeFeatureStreamDirect (stream, res, req, directSolrClient) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req)

  // Get batch size from config or use default
  const Config = require('../config')
  const joinConfig = Config.get('sequenceJoin') || {}
  const batchSize = joinConfig.batchSize || SEQUENCE_BATCH
  const prefetchBatches = joinConfig.prefetchBatches || 2

  // Determine if we need to join with genome collection
  const includeGenomeMetadata = needsGenomeJoin(req)

  let pipelineStream = stream

  // Add genome metadata join if needed
  if (includeGenomeMetadata && GenomeMetadataJoinStream) {
    debug('Adding genome metadata join to pipeline')
    const genomeJoinStream = new GenomeMetadataJoinStream(directSolrClient, {
      batchSize: 50,
      cacheSize: 100,
      skipHeader: true
    })
    pipelineStream = stream.pipe(genomeJoinStream)
  }

  // Create sequence join stream
  const sequenceJoinStream = new SequenceJoinStream(directSolrClient, {
    sequenceField: 'na_sequence_md5',
    batchSize,
    prefetchBatches,
    skipHeader: !includeGenomeMetadata // Only skip header if genome join didn't already
  })

  pipelineStream = pipelineStream.pipe(sequenceJoinStream)

  // Use streamWithBackpressure to handle output
  await streamWithBackpressure(pipelineStream, res, {
    skipFirstDoc: false, // Join streams already handle header skipping
    transform: (doc) => formatFastaRecord(doc, headerFormatter),
    onEnd: (count) => {
      const stats = sequenceJoinStream.getStats()
      debug(`DNA FASTA complete: ${count} records, ${stats.totalSequences} sequences, ${stats.missingSequences} missing`)
    }
  })
}

/**
 * Serialize genome_feature stream using legacy HTTP batch lookups (fallback).
 */
async function serializeFeatureStreamLegacy (stream, res, req) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req)
  let isFirstDoc = true
  const buffer = []

  // Process documents with batching
  await new Promise((resolve, reject) => {
    let destroyed = false

    const cleanup = () => {
      if (!destroyed) {
        destroyed = true
        stream.removeAllListeners()
      }
    }

    const flushBuffer = async () => {
      if (buffer.length === 0) return

      const hashes = buffer.map(d => d.na_sequence_md5).filter(h => h)
      let seqhash = {}

      if (hashes.length > 0) {
        try {
          seqhash = await getSequenceDictByHash(hashes, req)
        } catch (err) {
          debug(`Error fetching sequences: ${err.message}`)
        }
      }

      for (const doc of buffer) {
        if (doc.na_sequence_md5 && seqhash[doc.na_sequence_md5]) {
          doc.sequence = seqhash[doc.na_sequence_md5]
        }
        res.write(formatFastaRecord(doc, headerFormatter))
      }

      buffer.length = 0
    }

    stream.on('data', async (doc) => {
      if (destroyed) return

      // Skip first doc (metadata header)
      if (isFirstDoc) {
        isFirstDoc = false
        return
      }

      buffer.push(doc)

      if (buffer.length >= SEQUENCE_BATCH) {
        stream.pause()
        await flushBuffer()
        if (!destroyed) {
          stream.resume()
        }
      }
    })

    stream.on('end', async () => {
      if (destroyed) return
      await flushBuffer()
      cleanup()
      res.end()
      resolve()
    })

    stream.on('error', (err) => {
      cleanup()
      reject(err)
    })

    res.on('close', () => {
      if (!res.writableEnded && !destroyed) {
        cleanup()
        stream.destroy()
      }
    })
  })
}

/**
 * Serialize genome_sequence stream (no join needed, sequences are inline).
 */
async function serializeGenomeSequenceStream (stream, res) {
  await streamWithBackpressure(stream, res, {
    transform: (doc) => formatGenomeSequenceRecord(doc)
  })
}

/**
 * Serialize non-streaming results (query mode).
 */
async function serializeQueryResults (docs, res, req) {
  const collection = req.call_collection

  if (collection === 'genome_feature') {
    const headerFormatter = createFastaHeaderFormatterFromRequest(req)
    const numFound = docs.length

    // Enrich with genome metadata if needed
    if (needsGenomeJoin(req) && numFound > 0) {
      const genomeIds = [...new Set(docs.map(d => d.genome_id).filter(id => id))]
      debug(`Query mode: enriching ${numFound} docs with genome metadata for ${genomeIds.length} genomes`)

      const genomeMetadata = await getGenomeMetadataDict(genomeIds, req)

      for (const doc of docs) {
        if (doc.genome_id && genomeMetadata[doc.genome_id]) {
          doc.genome_metadata = genomeMetadata[doc.genome_id]
        }
      }
    }

    // Try direct Solr client first
    const directClient = initializeDirectSolr()

    if (directClient) {
      // Fetch sequences in batches using direct client
      for (let i = 0; i < numFound; i += SEQUENCE_BATCH) {
        const batch = docs.slice(i, Math.min(i + SEQUENCE_BATCH, numFound))
        const hashes = batch.map(d => d.na_sequence_md5).filter(h => h)

        if (hashes.length > 0) {
          try {
            const seqDict = await directClient.fetchSequencesByMd5(hashes)
            for (const doc of batch) {
              if (doc.na_sequence_md5 && seqDict[doc.na_sequence_md5]) {
                doc.sequence = seqDict[doc.na_sequence_md5]
              }
            }
          } catch (err) {
            debug(`Direct sequence fetch failed, falling back: ${err.message}`)
            // Fall back to HTTP for this batch
            const seqDict = await getSequenceDictByHash(hashes, req)
            for (const doc of batch) {
              if (doc.na_sequence_md5 && seqDict[doc.na_sequence_md5]) {
                doc.sequence = seqDict[doc.na_sequence_md5]
              }
            }
          }
        }

        // Write batch
        for (const doc of batch) {
          res.write(formatFastaRecord(doc, headerFormatter))
        }
      }
    } else {
      // Legacy HTTP-based sequence fetching
      let sequenceDict = {}

      for (let i = 0; i < numFound; i += SEQUENCE_BATCH) {
        const batch = docs.slice(i, Math.min(i + SEQUENCE_BATCH, numFound))
        const hashes = batch
          .map(d => d.na_sequence_md5)
          .filter(h => h && !sequenceDict[h])

        if (hashes.length > 0) {
          const dict = await getSequenceDictByHash(hashes, req)
          sequenceDict = { ...sequenceDict, ...dict }
        }

        for (const doc of batch) {
          if (doc.na_sequence_md5) {
            doc.sequence = sequenceDict[doc.na_sequence_md5]
          }
          res.write(formatFastaRecord(doc, headerFormatter))
        }
      }
    }
  } else if (collection === 'genome_sequence') {
    for (const doc of docs) {
      res.write(formatGenomeSequenceRecord(doc))
    }
  }
}

module.exports = {
  contentType: 'application/dna+fasta',

  serialize: async function (req, res, next) {
    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.fasta`)
    }

    try {
      if (req.call_method === 'stream') {
        const results = await Promise.resolve(res.results)

        if (!results.stream) {
          throw new Error('Expected ReadStream in Serializer')
        }

        const collection = req.call_collection

        if (collection === 'genome_feature') {
          // Try to use direct Solr client for efficient sequence lookups
          const directClient = initializeDirectSolr()

          if (directClient && SequenceJoinStream) {
            debug('Using direct Solr sequence join')
            await serializeFeatureStreamDirect(results.stream, res, req, directClient)
          } else {
            debug('Using legacy HTTP sequence lookup')
            await serializeFeatureStreamLegacy(results.stream, res, req)
          }
        } else if (collection === 'genome_sequence') {
          await serializeGenomeSequenceStream(results.stream, res)
        } else {
          // Unknown collection, just end
          res.end()
        }
      } else {
        // Query mode (non-streaming)
        if (res.results?.response?.docs) {
          await serializeQueryResults(res.results.response.docs, res, req)
        }
        res.end()
      }
    } catch (error) {
      debug(`Serialization error: ${error.message}`)
      next(new Error(`Unable to serialize FASTA: ${error.message}`))
    }
  }
}
