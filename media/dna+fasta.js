/**
 * DNA FASTA Serializer
 *
 * Serializes genome features and genome sequences to DNA FASTA format.
 *
 * Features:
 * - Streaming with proper backpressure handling
 * - Efficient batch sequence lookups via SequenceJoinStream
 * - Configurable FASTA headers via request parameters
 * - Falls back to legacy HTTP-based lookups if direct Solr not available
 *
 * Request parameters for custom headers:
 *   - http_fasta_id_fields: comma-separated fields for ID (e.g., 'patric_id,gene')
 *   - http_fasta_id_delimiter: delimiter between ID fields (default: '|')
 *   - http_fasta_description_fields: comma-separated fields for description
 *   - http_fasta_context_fields: comma-separated fields for [context]
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
let DirectSolrClient = null
let SolrClusterClient = null
let solrClusterClientInstance = null
let directSolrClientInstance = null

// Legacy imports for fallback mode
const { getSequenceDictByHash } = require('../util/featureSequence')
const SEQUENCE_BATCH = 200

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
    DirectSolrClient = require('../lib/distributed/DirectSolrClient')
    SolrClusterClient = require('../lib/distributed/SolrClusterClient')

    // Create cluster client (reuse if exists)
    if (!solrClusterClientInstance) {
      solrClusterClientInstance = new SolrClusterClient(solrUrl)
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
 * Serialize genome_feature stream using SequenceJoinStream (new efficient path).
 */
async function serializeFeatureStreamDirect (stream, res, req, directSolrClient) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req)

  // Get batch size from config or use default
  const Config = require('../config')
  const joinConfig = Config.get('sequenceJoin') || {}
  const batchSize = joinConfig.batchSize || SEQUENCE_BATCH
  const prefetchBatches = joinConfig.prefetchBatches || 2

  // Create sequence join stream
  const joinStream = new SequenceJoinStream(directSolrClient, {
    sequenceField: 'na_sequence_md5',
    batchSize,
    prefetchBatches,
    skipHeader: true
  })

  // Pipe source through join stream
  stream.pipe(joinStream)

  // Use streamWithBackpressure to handle output
  await streamWithBackpressure(joinStream, res, {
    skipFirstDoc: false, // SequenceJoinStream already handles header skipping
    transform: (doc) => formatFastaRecord(doc, headerFormatter),
    onEnd: (count) => {
      const stats = joinStream.getStats()
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
