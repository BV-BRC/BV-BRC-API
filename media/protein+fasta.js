/**
 * Protein FASTA Serializer
 *
 * Serializes genome features to protein FASTA format.
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

const debug = require('debug')('p3api-server:media:protein-fasta')
const LineWrap = require('../util/linewrap')
const { streamWithBackpressure } = require('../util/streamWithBackpressure')
const {
  createFastaHeaderFormatterFromRequest,
  formatLegacyHeader
} = require('../util/fastaHeaderFormatter')

// Lazy-loaded dependencies for direct Solr access
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

    SequenceJoinStream = require('../lib/distributed/SequenceJoinStream')
    GenomeMetadataJoinStream = require('../lib/distributed/GenomeMetadataJoinStream')
    DirectSolrClient = require('../lib/distributed/DirectSolrClient')
    SolrClusterClient = require('../lib/distributed/SolrClusterClient')

    if (!solrClusterClientInstance) {
      solrClusterClientInstance = new SolrClusterClient(solrUrl)
    }

    directSolrClientInstance = new DirectSolrClient(solrClusterClientInstance)

    debug('Direct Solr client initialized for protein sequence lookups')
    return directSolrClientInstance
  } catch (err) {
    debug(`Failed to initialize direct Solr client: ${err.message}`)
    return null
  }
}

/**
 * Format a single document as protein FASTA record.
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
 * Check if any FASTA header fields reference genome_metadata.
 *
 * @param {Object} req - Express request object
 * @returns {boolean} True if genome join is needed
 */
function needsGenomeJoin (req) {
  const fastaParams = req.fastaParams || {}
  console.log(`[FASTA DEBUG] needsGenomeJoin: fastaParams = ${JSON.stringify(fastaParams)}`)
  const fieldsToCheck = [
    fastaParams.http_fasta_id_fields,
    fastaParams.http_fasta_description_fields,
    fastaParams.http_fasta_context_fields
  ]

  const result = fieldsToCheck.some(fields => {
    return fields && fields.includes('genome_metadata.')
  })
  console.log(`[FASTA DEBUG] needsGenomeJoin: result = ${result}`)
  return result
}

/**
 * Serialize genome_feature stream using SequenceJoinStream (efficient path).
 * Optionally enriches with genome metadata if genome_metadata.* fields are requested.
 */
async function serializeFeatureStreamDirect (stream, res, req, directSolrClient) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req, { sequenceType: 'protein' })

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

  // Create sequence join stream for protein sequences
  const sequenceJoinStream = new SequenceJoinStream(directSolrClient, {
    sequenceField: 'aa_sequence_md5', // Protein sequences
    batchSize,
    prefetchBatches,
    skipHeader: !includeGenomeMetadata // Only skip header if genome join didn't already
  })

  pipelineStream = pipelineStream.pipe(sequenceJoinStream)

  await streamWithBackpressure(pipelineStream, res, {
    skipFirstDoc: false,
    transform: (doc) => formatFastaRecord(doc, headerFormatter),
    onEnd: (count) => {
      const stats = sequenceJoinStream.getStats()
      debug(`Protein FASTA complete: ${count} records, ${stats.totalSequences} sequences, ${stats.missingSequences} missing`)
    }
  })
}

/**
 * Serialize genome_feature stream using legacy HTTP batch lookups (fallback).
 */
async function serializeFeatureStreamLegacy (stream, res, req) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req, { sequenceType: 'protein' })
  let isFirstDoc = true
  const buffer = []

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

      const hashes = buffer.map(d => d.aa_sequence_md5).filter(h => h)
      let seqhash = {}

      if (hashes.length > 0) {
        try {
          seqhash = await getSequenceDictByHash(hashes, req)
        } catch (err) {
          debug(`Error fetching protein sequences: ${err.message}`)
        }
      }

      for (const doc of buffer) {
        if (doc.aa_sequence_md5 && seqhash[doc.aa_sequence_md5]) {
          doc.sequence = seqhash[doc.aa_sequence_md5]
        }
        res.write(formatFastaRecord(doc, headerFormatter))
      }

      buffer.length = 0
    }

    stream.on('data', async (doc) => {
      if (destroyed) return

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
 * Serialize non-streaming results (query mode).
 */
async function serializeQueryResults (docs, res, req) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req, { sequenceType: 'protein' })
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

  const directClient = initializeDirectSolr()

  if (directClient) {
    for (let i = 0; i < numFound; i += SEQUENCE_BATCH) {
      const batch = docs.slice(i, Math.min(i + SEQUENCE_BATCH, numFound))
      const hashes = batch.map(d => d.aa_sequence_md5).filter(h => h)

      if (hashes.length > 0) {
        try {
          const seqDict = await directClient.fetchSequencesByMd5(hashes)
          for (const doc of batch) {
            if (doc.aa_sequence_md5 && seqDict[doc.aa_sequence_md5]) {
              doc.sequence = seqDict[doc.aa_sequence_md5]
            }
          }
        } catch (err) {
          debug(`Direct protein sequence fetch failed, falling back: ${err.message}`)
          const seqDict = await getSequenceDictByHash(hashes, req)
          for (const doc of batch) {
            if (doc.aa_sequence_md5 && seqDict[doc.aa_sequence_md5]) {
              doc.sequence = seqDict[doc.aa_sequence_md5]
            }
          }
        }
      }

      for (const doc of batch) {
        res.write(formatFastaRecord(doc, headerFormatter))
      }
    }
  } else {
    let sequenceDict = {}

    for (let i = 0; i < numFound; i += SEQUENCE_BATCH) {
      const batch = docs.slice(i, Math.min(i + SEQUENCE_BATCH, numFound))
      const hashes = batch
        .map(d => d.aa_sequence_md5)
        .filter(h => h && !sequenceDict[h])

      if (hashes.length > 0) {
        const dict = await getSequenceDictByHash(hashes, req)
        sequenceDict = { ...sequenceDict, ...dict }
      }

      for (const doc of batch) {
        if (doc.aa_sequence_md5) {
          doc.sequence = sequenceDict[doc.aa_sequence_md5]
        }
        res.write(formatFastaRecord(doc, headerFormatter))
      }
    }
  }
}

module.exports = {
  contentType: 'application/protein+fasta',

  serialize: async function (req, res, next) {
    console.log(`[FASTA DEBUG] serialize: call_method=${req.call_method}, fastaParams=${JSON.stringify(req.fastaParams || {})}`)

    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.fasta`)
    }

    try {
      if (req.call_method === 'stream') {
        const results = await Promise.resolve(res.results)

        if (!results.stream) {
          throw new Error('Expected ReadStream in Serializer')
        }

        if (req.call_collection === 'genome_feature') {
          const directClient = initializeDirectSolr()

          if (directClient && SequenceJoinStream) {
            debug('Using direct Solr protein sequence join')
            await serializeFeatureStreamDirect(results.stream, res, req, directClient)
          } else {
            debug('Using legacy HTTP protein sequence lookup')
            await serializeFeatureStreamLegacy(results.stream, res, req)
          }
        } else {
          // For other collections (like genome_sequence), just end
          // Protein FASTA doesn't make sense for genome_sequence
          res.end()
        }
      } else {
        // Query mode (non-streaming)
        if (res.results?.response?.docs && req.call_collection === 'genome_feature') {
          await serializeQueryResults(res.results.response.docs, res, req)
        }
        res.end()
      }
    } catch (error) {
      debug(`Serialization error: ${error.message}`)
      next(new Error(`Unable to serialize protein FASTA: ${error.message}`))
    }
  }
}
