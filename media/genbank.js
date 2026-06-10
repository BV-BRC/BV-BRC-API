/**
 * Genbank Format Serializer (Streaming)
 *
 * Generates Genbank flat file format for genome data with streaming support.
 * Produces one Genbank record per contig (default) or a single merged record.
 *
 * Streaming mode (multi-record):
 *   - Streams contigs one at a time
 *   - For each contig, streams features
 *   - Minimal memory usage: only current contig + current feature in memory
 *
 * Non-streaming mode (merged):
 *   - Requires all contigs and features in memory for coordinate adjustment
 *   - Use only for genomes that fit comfortably in memory
 *
 * Usage:
 *   GET /genome_sequence/?eq(genome_id,GENOME_ID)&http_accept=application/genbank
 *   GET /genome_feature/?eq(genome_id,GENOME_ID)&http_accept=application/genbank
 *
 * Options (via query parameters):
 *   http_genbank_merged=true - Merge all contigs into a single record
 *                              (useful for tools like Artemis)
 */

const debug = require('debug')('p3api-server:media:genbank')
const axios = require('axios')
const Config = require('../config')
const { Transform } = require('stream')

const SEQUENCE_LINE_LENGTH = 60 // Characters per sequence line
const SEQUENCE_BLOCK_SIZE = 10 // Characters per block in sequence

/**
 * Format a date as DD-MMM-YYYY (Genbank format)
 */
function formatGenbankDate (date) {
  if (!date) {
    return new Date().toLocaleDateString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).toUpperCase().replace(/,/g, '')
  }
  const d = new Date(date)
  return d.toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).toUpperCase().replace(/,/g, '')
}

/**
 * Pad a string to a specific width
 */
function pad (str, width, char = ' ') {
  str = String(str || '')
  while (str.length < width) {
    str = char + str
  }
  return str
}

/**
 * Wrap text with proper Genbank indentation
 */
function wrapText (text, indent = 12, width = 80) {
  if (!text || typeof text !== 'string') {
    return ''
  }
  const lines = []
  const words = text.split(/\s+/)
  let currentLine = ''
  const indentStr = ' '.repeat(indent)

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word
    } else if (currentLine.length + 1 + word.length <= width - indent) {
      currentLine += ' ' + word
    } else {
      lines.push(currentLine)
      currentLine = word
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines.map((line, i) => (i === 0 ? '' : indentStr) + line).join('\n')
}

/**
 * Format a location string for Genbank
 * @param {number} start - 1-based start position
 * @param {number} end - 1-based end position
 * @param {string} strand - '+' or '-'
 * @returns {string} Genbank location string
 */
function formatLocation (start, end, strand) {
  if (strand === '-') {
    return `complement(${start}..${end})`
  }
  return `${start}..${end}`
}

/**
 * Format a feature qualifier
 */
function formatQualifier (name, value) {
  if (value === undefined || value === null || value === '') {
    return ''
  }
  // Escape quotes in value
  const escaped = String(value).replace(/"/g, '')
  return `/${name}="${escaped}"`
}

/**
 * Wrap a qualifier value across multiple lines
 */
function wrapQualifierValue (name, value, maxLen) {
  if (value === undefined || value === null) {
    return []
  }
  const lines = []
  const escaped = String(value).replace(/"/g, '')

  if (escaped.length <= maxLen - name.length - 4) {
    return [`/${name}="${escaped}"`]
  }

  // Need to split
  let remaining = escaped
  let first = true
  while (remaining.length > 0) {
    const chunkLen = first ? maxLen - name.length - 4 : maxLen - 1
    const chunk = remaining.substring(0, chunkLen)
    remaining = remaining.substring(chunkLen)

    if (first) {
      lines.push(`/${name}="${chunk}`)
      first = false
    } else if (remaining.length === 0) {
      lines.push(`${chunk}"`)
    } else {
      lines.push(chunk)
    }
  }

  return lines
}

/**
 * Map feature_type to Genbank feature type
 */
function mapFeatureType (featureType) {
  const mapping = {
    CDS: 'CDS',
    tRNA: 'tRNA',
    rRNA: 'rRNA',
    misc_RNA: 'misc_RNA',
    ncRNA: 'ncRNA',
    tmRNA: 'tmRNA',
    pseudogene: 'gene',
    repeat_region: 'repeat_region',
    source: 'source',
    assembly_gap: 'assembly_gap'
  }
  return mapping[featureType] || 'misc_feature'
}

/**
 * Format a feature for Genbank output - returns string
 */
function formatFeature (feature, featureType) {
  const lines = []
  const location = formatLocation(feature.start, feature.end, feature.strand)

  // Feature type and location (5 chars for type, 16 chars total before location)
  const typeStr = featureType.padEnd(16)
  lines.push(`     ${typeStr}${location}`)

  // Add qualifiers with 21-character indent
  const qualIndent = ' '.repeat(21)

  // Handle assembly_gap (contig boundary markers) specially
  if (featureType === 'assembly_gap') {
    lines.push(`${qualIndent}/estimated_length=0`)
    lines.push(`${qualIndent}/gap_type="within scaffold"`)
    if (feature.product) {
      lines.push(`${qualIndent}/note="${feature.product}"`)
    }
    return lines.join('\n')
  }

  // Locus tag
  if (feature.patric_id) {
    lines.push(`${qualIndent}${formatQualifier('locus_tag', feature.patric_id)}`)
  }
  if (feature.refseq_locus_tag) {
    lines.push(`${qualIndent}${formatQualifier('old_locus_tag', feature.refseq_locus_tag)}`)
  }

  // Gene symbol
  if (feature.gene) {
    lines.push(`${qualIndent}${formatQualifier('gene', feature.gene)}`)
  }

  // Product
  if (feature.product) {
    // Wrap long product names
    const productLines = wrapQualifierValue('product', feature.product, 58)
    for (const pl of productLines) {
      lines.push(`${qualIndent}${pl}`)
    }
  }

  // EC numbers (extract from product if present)
  const ecMatch = feature.product?.match(/\(EC\s+([\d.\-]+)\)/g)
  if (ecMatch) {
    for (const ec of ecMatch) {
      const ecNum = ec.match(/[\d.\-]+/)[0]
      lines.push(`${qualIndent}${formatQualifier('EC_number', ecNum)}`)
    }
  }

  // Protein ID
  if (feature.protein_id) {
    lines.push(`${qualIndent}${formatQualifier('protein_id', feature.protein_id)}`)
  }

  // Database cross-references
  if (feature.figfam_id) {
    lines.push(`${qualIndent}${formatQualifier('db_xref', `FIGfam:${feature.figfam_id}`)}`)
  }
  if (feature.pgfam_id) {
    lines.push(`${qualIndent}${formatQualifier('db_xref', `PGfam:${feature.pgfam_id}`)}`)
  }
  if (feature.plfam_id) {
    lines.push(`${qualIndent}${formatQualifier('db_xref', `PLfam:${feature.plfam_id}`)}`)
  }

  // Translation table for CDS
  if (featureType === 'CDS') {
    lines.push(`${qualIndent}${formatQualifier('transl_table', '11')}`)
    lines.push(`${qualIndent}${formatQualifier('codon_start', '1')}`)
  }

  return lines.join('\n')
}

/**
 * Format the ORIGIN section with sequence data - returns string
 */
function formatOrigin (sequence) {
  const lines = ['ORIGIN']
  let pos = 1

  for (let i = 0; i < sequence.length; i += SEQUENCE_LINE_LENGTH) {
    const lineSeq = sequence.substring(i, i + SEQUENCE_LINE_LENGTH).toLowerCase()
    const blocks = []

    for (let j = 0; j < lineSeq.length; j += SEQUENCE_BLOCK_SIZE) {
      blocks.push(lineSeq.substring(j, j + SEQUENCE_BLOCK_SIZE))
    }

    lines.push(pad(pos, 9) + ' ' + blocks.join(' '))
    pos += SEQUENCE_LINE_LENGTH
  }

  lines.push('//')
  return lines.join('\n')
}

/**
 * Write Genbank record header (LOCUS through FEATURES line)
 */
function writeRecordHeader (res, genome, contig) {
  const seqLength = contig.length || contig.sequence?.length || 0
  const accession = contig.accession || contig.sequence_id || 'unknown'
  const topology = contig.topology || 'linear'
  const moleculeType = 'DNA'
  const division = 'BCT'
  const date = formatGenbankDate(contig.release_date || genome.completion_date)

  // LOCUS line
  const locusName = accession.substring(0, 16).padEnd(16)
  const lengthStr = String(seqLength).padStart(11) + ' bp'
  const molStr = moleculeType.padStart(7)
  const topoStr = topology.padEnd(8)
  res.write(`LOCUS       ${locusName} ${lengthStr}    ${molStr}     ${topoStr} ${division} ${date}\n`)

  // DEFINITION
  const definition = contig.description || `${genome.genome_name || genome.organism_name} ${accession}`
  res.write(`DEFINITION  ${wrapText(definition, 12)}\n`)

  // ACCESSION
  res.write(`ACCESSION   ${accession}\n`)

  // VERSION
  const version = contig.version ? `${accession}.${contig.version}` : accession
  res.write(`VERSION     ${version}\n`)

  // DBLINK
  if (genome.bioproject_accession || genome.biosample_accession || genome.genome_id) {
    let firstDblink = true
    if (genome.bioproject_accession) {
      res.write(`DBLINK      BioProject: ${genome.bioproject_accession}\n`)
      firstDblink = false
    }
    if (genome.biosample_accession) {
      res.write(`${firstDblink ? 'DBLINK      ' : '            '}BioSample: ${genome.biosample_accession}\n`)
      firstDblink = false
    }
    if (genome.genome_id) {
      res.write(`${firstDblink ? 'DBLINK      ' : '            '}BV-BRC: ${genome.genome_id}\n`)
    }
  }

  // KEYWORDS
  res.write('KEYWORDS    .\n')

  // SOURCE
  const organism = genome.genome_name || genome.organism_name || 'Unknown organism'
  res.write(`SOURCE      ${organism}\n`)
  res.write(`  ORGANISM  ${organism}\n`)

  // Taxonomy lineage
  if (genome.taxon_lineage_names) {
    const lineage = Array.isArray(genome.taxon_lineage_names)
      ? genome.taxon_lineage_names.join('; ')
      : genome.taxon_lineage_names
    res.write(`            ${wrapText(lineage + '.', 12)}\n`)
  }

  // REFERENCE
  res.write('REFERENCE   1  (bases 1 to ' + seqLength + ')\n')
  res.write('  AUTHORS   BV-BRC.\n')
  res.write('  TITLE     Direct Submission\n')
  res.write('  JOURNAL   Exported from BV-BRC (https://www.bv-brc.org/)\n')

  // COMMENT
  if (genome.comments) {
    res.write(`COMMENT     ${wrapText(genome.comments, 12)}\n`)
  }

  // FEATURES header
  res.write('FEATURES             Location/Qualifiers\n')

  // Source feature
  res.write(`     source          1..${seqLength}\n`)
  res.write(`                     /organism="${organism}"\n`)
  res.write(`                     /mol_type="genomic DNA"\n`)
  if (genome.strain) {
    res.write(`                     /strain="${genome.strain}"\n`)
  }
  if (genome.taxon_id) {
    res.write(`                     /db_xref="taxon:${genome.taxon_id}"\n`)
  }
  if (genome.genome_id) {
    res.write(`                     /db_xref="BV-BRC:${genome.genome_id}"\n`)
  }
}

/**
 * Stream features for a single contig and write them to response
 */
async function streamFeaturesForContig (res, genomeId, accession, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_feature/'

  const fields = 'feature_type,start,end,strand,patric_id,refseq_locus_tag,gene,product,protein_id,figfam_id,pgfam_id,plfam_id'
  const q = `eq(genome_id,${genomeId})&eq(accession,${encodeURIComponent(accession)})&ne(feature_type,source)&sort(+start)&limit(100000)&select(${fields})`

  debug(`Streaming features for contig ${accession}`)

  return new Promise((resolve, reject) => {
    axios({
      method: 'post',
      url: url,
      data: q,
      headers: {
        accept: 'application/json',
        'content-type': 'application/rqlquery+x-www-form-urlencoded',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      },
      responseType: 'stream'
    }).then(response => {
      let buffer = ''
      let featureCount = 0
      let inArray = false

      response.data.on('data', (chunk) => {
        buffer += chunk.toString()

        // Parse JSON array incrementally
        // We expect: [{...},{...},...]
        let startIdx = 0

        while (startIdx < buffer.length) {
          // Skip whitespace and array brackets
          while (startIdx < buffer.length && /[\s\[,]/.test(buffer[startIdx])) {
            if (buffer[startIdx] === '[') inArray = true
            startIdx++
          }

          if (startIdx >= buffer.length) break

          // Check for end of array
          if (buffer[startIdx] === ']') {
            buffer = buffer.substring(startIdx + 1)
            break
          }

          // Try to find complete JSON object
          if (buffer[startIdx] === '{') {
            let depth = 0
            let endIdx = startIdx
            let inString = false
            let escaped = false

            while (endIdx < buffer.length) {
              const char = buffer[endIdx]

              if (escaped) {
                escaped = false
              } else if (char === '\\' && inString) {
                escaped = true
              } else if (char === '"' && !escaped) {
                inString = !inString
              } else if (!inString) {
                if (char === '{') depth++
                else if (char === '}') {
                  depth--
                  if (depth === 0) {
                    // Found complete object
                    const jsonStr = buffer.substring(startIdx, endIdx + 1)
                    try {
                      const feature = JSON.parse(jsonStr)
                      if (feature.feature_type !== 'source') {
                        const gbType = mapFeatureType(feature.feature_type)
                        res.write(formatFeature(feature, gbType) + '\n')
                        featureCount++
                      }
                    } catch (e) {
                      debug(`Failed to parse feature JSON: ${e.message}`)
                    }
                    startIdx = endIdx + 1
                    break
                  }
                }
              }
              endIdx++
            }

            // If we didn't find complete object, keep buffer for next chunk
            if (depth !== 0) {
              buffer = buffer.substring(startIdx)
              break
            }
          } else {
            // Not a valid start, skip
            startIdx++
          }
        }

        // Keep remaining incomplete data
        if (startIdx < buffer.length && !buffer.substring(startIdx).match(/^[\s\]]*$/)) {
          buffer = buffer.substring(startIdx)
        } else {
          buffer = ''
        }
      })

      response.data.on('end', () => {
        debug(`Streamed ${featureCount} features for contig ${accession}`)
        resolve(featureCount)
      })

      response.data.on('error', (err) => {
        debug(`Error streaming features: ${err.message}`)
        reject(err)
      })
    }).catch(reject)
  })
}

/**
 * Write ORIGIN section with sequence
 */
function writeOrigin (res, sequence) {
  if (sequence) {
    res.write(formatOrigin(sequence) + '\n')
  } else {
    res.write('ORIGIN\n//\n')
  }
}

/**
 * Stream contigs and generate Genbank records
 */
async function streamGenbankMultiRecord (res, genomeId, genome, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_sequence/'

  const q = `eq(genome_id,${genomeId})&sort(+accession)&limit(10000)`

  debug(`Streaming contigs for genome ${genomeId}`)

  return new Promise((resolve, reject) => {
    axios({
      method: 'post',
      url: url,
      data: q,
      headers: {
        accept: 'application/json',
        'content-type': 'application/rqlquery+x-www-form-urlencoded',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      },
      responseType: 'stream'
    }).then(response => {
      let buffer = ''
      let contigCount = 0
      let isFirstContig = true
      const contigQueue = []
      let processing = false
      let streamEnded = false
      let currentProcessingPromise = null

      const processContigQueue = async () => {
        if (processing) return currentProcessingPromise
        if (contigQueue.length === 0) return Promise.resolve()

        processing = true
        currentProcessingPromise = (async () => {
          while (contigQueue.length > 0) {
            const contig = contigQueue.shift()
            const accession = contig.accession || contig.sequence_id

            debug(`Processing contig ${accession}`)

            // Add newline between records
            if (!isFirstContig) {
              res.write('\n')
            }
            isFirstContig = false

            // Write header
            writeRecordHeader(res, genome, contig)

            // Stream features
            try {
              await streamFeaturesForContig(res, genomeId, accession, req)
            } catch (err) {
              debug(`Error streaming features for ${accession}: ${err.message}`)
            }

            // Write sequence
            writeOrigin(res, contig.sequence)
            contigCount++
          }
          processing = false
        })()

        return currentProcessingPromise
      }

      const checkComplete = async () => {
        if (streamEnded && contigQueue.length === 0 && !processing) {
          debug(`Streamed ${contigCount} contigs for genome ${genomeId}`)
          resolve(contigCount)
        } else if (streamEnded && (contigQueue.length > 0 || processing)) {
          // Wait for processing to complete
          if (currentProcessingPromise) {
            await currentProcessingPromise
          }
          // Process any remaining items
          if (contigQueue.length > 0) {
            await processContigQueue()
          }
          debug(`Streamed ${contigCount} contigs for genome ${genomeId}`)
          resolve(contigCount)
        }
      }

      response.data.on('data', (chunk) => {
        buffer += chunk.toString()

        // Parse JSON array incrementally
        let startIdx = 0

        while (startIdx < buffer.length) {
          while (startIdx < buffer.length && /[\s\[,]/.test(buffer[startIdx])) {
            startIdx++
          }

          if (startIdx >= buffer.length) break
          if (buffer[startIdx] === ']') {
            buffer = buffer.substring(startIdx + 1)
            break
          }

          if (buffer[startIdx] === '{') {
            let depth = 0
            let endIdx = startIdx
            let inString = false
            let escaped = false

            while (endIdx < buffer.length) {
              const char = buffer[endIdx]

              if (escaped) {
                escaped = false
              } else if (char === '\\' && inString) {
                escaped = true
              } else if (char === '"' && !escaped) {
                inString = !inString
              } else if (!inString) {
                if (char === '{') depth++
                else if (char === '}') {
                  depth--
                  if (depth === 0) {
                    const jsonStr = buffer.substring(startIdx, endIdx + 1)
                    try {
                      const contig = JSON.parse(jsonStr)
                      contigQueue.push(contig)
                    } catch (e) {
                      debug(`Failed to parse contig JSON: ${e.message}`)
                    }
                    startIdx = endIdx + 1
                    break
                  }
                }
              }
              endIdx++
            }

            if (depth !== 0) {
              buffer = buffer.substring(startIdx)
              break
            }
          } else {
            startIdx++
          }
        }

        if (startIdx < buffer.length && !buffer.substring(startIdx).match(/^[\s\]]*$/)) {
          buffer = buffer.substring(startIdx)
        } else {
          buffer = ''
        }

        // Start processing if not already running
        processContigQueue()
      })

      response.data.on('end', async () => {
        streamEnded = true
        await checkComplete()
      })

      response.data.on('error', (err) => {
        debug(`Error streaming contigs: ${err.message}`)
        reject(err)
      })
    }).catch(reject)
  })
}

/**
 * Fetch genome metadata
 */
async function fetchGenome (genomeId, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome/'

  const q = `eq(genome_id,${genomeId})&limit(1)`
  const fields = 'genome_id,genome_name,organism_name,taxon_id,taxon_lineage_names,strain,bioproject_accession,biosample_accession,completion_date,comments'

  try {
    const response = await axios.post(url, `${q}&select(${fields})`, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/rqlquery+x-www-form-urlencoded',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      }
    })
    return response.data[0] || {}
  } catch (err) {
    debug(`Failed to fetch genome: ${err.message}`)
    return {}
  }
}

/**
 * Fetch contigs for merged mode (non-streaming - needs all data)
 */
async function fetchContigs (genomeId, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_sequence/'

  const q = `eq(genome_id,${genomeId})&limit(10000)&sort(+accession)`

  try {
    const response = await axios.post(url, q, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/rqlquery+x-www-form-urlencoded',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      }
    })
    return response.data || []
  } catch (err) {
    debug(`Failed to fetch contigs: ${err.message}`)
    return []
  }
}

/**
 * Fetch features for merged mode (non-streaming - needs all data)
 */
async function fetchFeatures (genomeId, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_feature/'

  const fields = 'accession,feature_type,start,end,strand,patric_id,refseq_locus_tag,gene,product,protein_id,figfam_id,pgfam_id,plfam_id,aa_sequence_md5'
  const q = `eq(genome_id,${genomeId})&ne(feature_type,source)&limit(100000)&select(${fields})`

  try {
    const response = await axios.post(url, q, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/rqlquery+x-www-form-urlencoded',
        authorization: (req && req.headers.authorization) ? req.headers.authorization : ''
      }
    })

    // Group features by accession
    const featuresByAccession = {}
    for (const feature of response.data || []) {
      const acc = feature.accession || 'unknown'
      if (!featuresByAccession[acc]) {
        featuresByAccession[acc] = []
      }
      featuresByAccession[acc].push(feature)
    }

    return featuresByAccession
  } catch (err) {
    debug(`Failed to fetch features: ${err.message}`)
    return {}
  }
}

/**
 * Generate merged Genbank record (non-streaming)
 */
function generateMergedGenbankRecord (genome, contigs, featuresByAccession) {
  // Build offset map and concatenate sequences
  const contigOffsets = {}
  const contigBoundaries = []
  let mergedSequence = ''
  let offset = 0

  for (const contig of contigs) {
    const acc = contig.accession || contig.sequence_id
    const seq = contig.sequence || ''
    const len = seq.length || contig.length || 0

    contigOffsets[acc] = offset

    if (offset > 0) {
      contigBoundaries.push({
        position: offset + 1,
        accession: acc,
        previousEnd: offset
      })
    }

    mergedSequence += seq
    offset += len
  }

  debug(`Merged ${contigs.length} contigs: total length ${mergedSequence.length}`)

  // Collect and adjust all features
  const allFeatures = []
  for (const [accession, features] of Object.entries(featuresByAccession)) {
    const contigOffset = contigOffsets[accession] || 0
    for (const feature of features) {
      allFeatures.push({
        ...feature,
        start: feature.start + contigOffset,
        end: feature.end + contigOffset,
        original_accession: accession
      })
    }
  }

  // Add contig boundary markers
  for (const boundary of contigBoundaries) {
    allFeatures.push({
      feature_type: 'assembly_gap',
      start: boundary.position,
      end: boundary.position,
      strand: '+',
      product: `Contig junction: ${boundary.accession}`,
      _is_boundary: true
    })
  }

  // Sort features by position
  allFeatures.sort((a, b) => a.start - b.start)

  debug(`Total features after merge: ${allFeatures.length} (including ${contigBoundaries.length} boundaries)`)

  // Create merged contig object
  const mergedContig = {
    accession: genome.genome_id,
    sequence_id: genome.genome_id,
    sequence: mergedSequence,
    length: mergedSequence.length,
    description: `${genome.genome_name || genome.organism_name || 'Unknown organism'}, complete genome`,
    topology: 'linear'
  }

  // Generate the record
  return generateGenbankRecord(genome, mergedContig, allFeatures)
}

/**
 * Generate a complete Genbank record (non-streaming, used for merged mode)
 */
function generateGenbankRecord (genome, contig, features) {
  const lines = []
  const seqLength = contig.length || contig.sequence?.length || 0
  const accession = contig.accession || contig.sequence_id || 'unknown'
  const topology = contig.topology || 'linear'
  const moleculeType = 'DNA'
  const division = 'BCT'
  const date = formatGenbankDate(contig.release_date || genome.completion_date)

  // LOCUS line
  const locusName = accession.substring(0, 16).padEnd(16)
  const lengthStr = String(seqLength).padStart(11) + ' bp'
  const molStr = moleculeType.padStart(7)
  const topoStr = topology.padEnd(8)
  lines.push(`LOCUS       ${locusName} ${lengthStr}    ${molStr}     ${topoStr} ${division} ${date}`)

  // DEFINITION
  const definition = contig.description || `${genome.genome_name || genome.organism_name} ${accession}`
  lines.push(`DEFINITION  ${wrapText(definition, 12)}`)

  // ACCESSION
  lines.push(`ACCESSION   ${accession}`)

  // VERSION
  const version = contig.version ? `${accession}.${contig.version}` : accession
  lines.push(`VERSION     ${version}`)

  // DBLINK
  if (genome.bioproject_accession || genome.biosample_accession || genome.genome_id) {
    let firstDblink = true
    if (genome.bioproject_accession) {
      lines.push(`DBLINK      BioProject: ${genome.bioproject_accession}`)
      firstDblink = false
    }
    if (genome.biosample_accession) {
      lines.push(`${firstDblink ? 'DBLINK      ' : '            '}BioSample: ${genome.biosample_accession}`)
      firstDblink = false
    }
    if (genome.genome_id) {
      lines.push(`${firstDblink ? 'DBLINK      ' : '            '}BV-BRC: ${genome.genome_id}`)
    }
  }

  // KEYWORDS
  lines.push('KEYWORDS    .')

  // SOURCE
  const organism = genome.genome_name || genome.organism_name || 'Unknown organism'
  lines.push(`SOURCE      ${organism}`)
  lines.push(`  ORGANISM  ${organism}`)

  // Taxonomy lineage
  if (genome.taxon_lineage_names) {
    const lineage = Array.isArray(genome.taxon_lineage_names)
      ? genome.taxon_lineage_names.join('; ')
      : genome.taxon_lineage_names
    lines.push(`            ${wrapText(lineage + '.', 12)}`)
  }

  // REFERENCE
  lines.push('REFERENCE   1  (bases 1 to ' + seqLength + ')')
  lines.push('  AUTHORS   BV-BRC.')
  lines.push('  TITLE     Direct Submission')
  lines.push('  JOURNAL   Exported from BV-BRC (https://www.bv-brc.org/)')

  // COMMENT
  if (genome.comments) {
    lines.push(`COMMENT     ${wrapText(genome.comments, 12)}`)
  }

  // FEATURES header
  lines.push('FEATURES             Location/Qualifiers')

  // Source feature
  lines.push(`     source          1..${seqLength}`)
  lines.push(`                     /organism="${organism}"`)
  lines.push(`                     /mol_type="genomic DNA"`)
  if (genome.strain) {
    lines.push(`                     /strain="${genome.strain}"`)
  }
  if (genome.taxon_id) {
    lines.push(`                     /db_xref="taxon:${genome.taxon_id}"`)
  }
  if (genome.genome_id) {
    lines.push(`                     /db_xref="BV-BRC:${genome.genome_id}"`)
  }

  // Sort and add features
  const sortedFeatures = [...features].sort((a, b) => a.start - b.start)
  for (const feature of sortedFeatures) {
    if (feature.feature_type === 'source') continue
    const gbType = mapFeatureType(feature.feature_type)
    lines.push(formatFeature(feature, gbType))
  }

  // ORIGIN and sequence
  if (contig.sequence) {
    lines.push(formatOrigin(contig.sequence))
  } else {
    lines.push('ORIGIN')
    lines.push('//')
  }

  return lines.join('\n')
}

module.exports = {
  contentType: 'application/genbank',

  serialize: async function (req, res, next) {
    debug('Genbank serializer called')

    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.gbk`)
    }

    try {
      // Check if merged format is requested
      const genbankParams = req.genbankParams || {}
      const isMerged = genbankParams.http_genbank_merged === 'true' ||
                       genbankParams.http_genbank_merged === true

      // Collect genome IDs to process
      let genomeIds = []

      if (req.call_collection === 'genome') {
        // For genome collection queries, process ALL genomes in result
        if (res.results?.response?.docs && res.results.response.docs.length > 0) {
          genomeIds = res.results.response.docs
            .map(doc => doc.genome_id)
            .filter(id => id)
        } else if (req.call_params?.[1]) {
          // Direct ID lookup
          genomeIds = [req.call_params[1]]
        }
      } else if (req.call_collection === 'genome_feature' || req.call_collection === 'genome_sequence') {
        // For feature/sequence queries, get unique genome_id from first result
        if (res.results?.response?.docs?.[0]?.genome_id) {
          genomeIds = [res.results.response.docs[0].genome_id]
        }
      }

      if (genomeIds.length === 0) {
        res.status(400).send('Genome ID is required for Genbank export')
        return
      }

      debug(`Generating Genbank for ${genomeIds.length} genome(s): ${genomeIds.slice(0, 5).join(', ')}${genomeIds.length > 5 ? '...' : ''}`)

      let isFirstGenome = true
      let totalContigs = 0

      for (const genomeId of genomeIds) {
        // Add newline separator between genomes (but records within a genome are already separated)
        if (!isFirstGenome) {
          res.write('\n')
        }
        isFirstGenome = false

        // Fetch genome metadata
        const genome = await fetchGenome(genomeId, req)

        if (isMerged) {
          // Merged mode: non-streaming, needs all data in memory per genome
          debug(`Generating merged Genbank record for genome ${genomeId}`)

          const [contigs, featuresByAccession] = await Promise.all([
            fetchContigs(genomeId, req),
            fetchFeatures(genomeId, req)
          ])

          if (contigs.length === 0) {
            debug(`No sequence data found for genome ${genomeId}, skipping`)
            continue
          }

          const record = generateMergedGenbankRecord(genome, contigs, featuresByAccession)
          res.write(record)
          totalContigs++
        } else {
          // Multi-record mode: streaming
          debug(`Streaming Genbank records for genome ${genomeId}`)

          const contigCount = await streamGenbankMultiRecord(res, genomeId, genome, req)
          totalContigs += contigCount

          if (contigCount === 0) {
            debug(`No contigs found for genome ${genomeId}`)
          }
        }
      }

      if (totalContigs === 0) {
        if (!res.headersSent) {
          res.status(404).send('No sequence data found for the specified genome(s)')
          return
        }
      }

      res.end()
    } catch (error) {
      debug(`Genbank serialization error: ${error.message}`)
      if (!res.headersSent) {
        next(new Error(`Unable to generate Genbank format: ${error.message}`))
      }
    }
  }
}
