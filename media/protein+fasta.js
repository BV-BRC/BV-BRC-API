/**
 * Protein FASTA Serializer
 *
 * Serializes genome features to protein FASTA format.
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

const debug = require('debug')('p3api-server:media:protein-fasta')
const LineWrap = require('../util/linewrap')
const { streamWithBackpressure } = require('../util/streamWithBackpressure')
const {
  createFastaHeaderFormatterFromRequest,
  formatLegacyHeader
} = require('../util/fastaHeaderFormatter')

// Lazy-loaded dependencies for direct Solr access
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
 * Serialize genome_feature stream using SequenceJoinStream (efficient path).
 */
async function serializeFeatureStreamDirect (stream, res, req, directSolrClient) {
  const headerFormatter = createFastaHeaderFormatterFromRequest(req, { sequenceType: 'protein' })

  const Config = require('../config')
  const joinConfig = Config.get('sequenceJoin') || {}
  const batchSize = joinConfig.batchSize || SEQUENCE_BATCH
  const prefetchBatches = joinConfig.prefetchBatches || 2

  // Create sequence join stream for protein sequences
  const joinStream = new SequenceJoinStream(directSolrClient, {
    sequenceField: 'aa_sequence_md5', // Protein sequences
    batchSize,
    prefetchBatches,
    skipHeader: true
  })

  stream.pipe(joinStream)

  await streamWithBackpressure(joinStream, res, {
    skipFirstDoc: false,
    transform: (doc) => formatFastaRecord(doc, headerFormatter),
    onEnd: (count) => {
      const stats = joinStream.getStats()
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
