/**
 * Genbank Format Serializer
 *
 * Generates Genbank flat file format for genome data.
 * Produces one Genbank record per contig, concatenated.
 *
 * Usage:
 *   GET /genome/GENOME_ID?http_accept=application/genbank
 *   GET /genome_feature/?eq(genome_id,GENOME_ID)&http_accept=application/genbank
 *
 * The serializer fetches:
 *   - Genome metadata (organism, taxon_id, etc.)
 *   - Contigs from genome_sequence collection
 *   - Features from genome_feature collection
 */

const debug = require('debug')('p3api-server:media:genbank')
const axios = require('axios')
const Config = require('../config')

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
 * Format a feature for Genbank output
 */
function formatFeature (feature, featureType) {
  const lines = []
  const location = formatLocation(feature.start, feature.end, feature.strand)

  // Feature type and location (5 chars for type, 16 chars total before location)
  const typeStr = featureType.padEnd(16)
  lines.push(`     ${typeStr}${location}`)

  // Add qualifiers with 21-character indent
  const qualIndent = ' '.repeat(21)

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

  // Protein translation for CDS (if available)
  // Note: We'd need to fetch this from feature_sequence - skip for now
  // TODO: Add protein translation

  return lines.join('\n')
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
 * Format the ORIGIN section with sequence data
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
    source: 'source'
  }
  return mapping[featureType] || 'misc_feature'
}

/**
 * Generate a Genbank record for one contig
 */
function generateGenbankRecord (genome, contig, features) {
  const lines = []
  const seqLength = contig.length || contig.sequence?.length || 0
  const accession = contig.accession || contig.sequence_id || 'unknown'
  const topology = contig.topology || 'linear'
  const moleculeType = 'DNA'
  const division = 'BCT' // Bacterial - could be determined from taxonomy
  const date = formatGenbankDate(contig.release_date || genome.completion_date)

  // LOCUS line
  // Format: LOCUS       name      length bp    molecule  topology  division  date
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

  // DBLINK (BioProject, BioSample, BV-BRC genome ID)
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

  // REFERENCE (optional - could add publication info)
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

  // Sort features by start position
  const sortedFeatures = [...features].sort((a, b) => a.start - b.start)

  // Add each feature
  for (const feature of sortedFeatures) {
    // Skip source features (we already added one)
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

  const q = `&eq(genome_id,${genomeId})&limit(1)`
  const fields = 'genome_id,genome_name,organism_name,taxon_id,taxon_lineage_names,strain,bioproject_accession,biosample_accession,completion_date,comments'

  try {
    const response = await axios.post(url, `${q}&select(${fields})`, {
      headers: {
        accept: 'application/json',
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
 * Fetch contigs for a genome
 */
async function fetchContigs (genomeId, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_sequence/'

  const q = `&eq(genome_id,${genomeId})&limit(10000)&sort(+accession)`

  try {
    const response = await axios.post(url, q, {
      headers: {
        accept: 'application/json',
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
 * Fetch features for a genome, grouped by accession
 */
async function fetchFeatures (genomeId, req) {
  const distributeURL = Config.get('distributeURL')
  let url = distributeURL
  if (url.charAt(url.length - 1) !== '/') {
    url += '/'
  }
  url += 'genome_feature/'

  const fields = 'accession,feature_type,start,end,strand,patric_id,refseq_locus_tag,gene,product,protein_id,figfam_id,pgfam_id,plfam_id,aa_sequence_md5'
  const q = `&eq(genome_id,${genomeId})&ne(feature_type,source)&limit(100000)&select(${fields})`

  try {
    const response = await axios.post(url, q, {
      headers: {
        accept: 'application/json',
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

module.exports = {
  contentType: 'application/genbank',

  serialize: async function (req, res, next) {
    debug('Genbank serializer called')

    if (req.isDownload) {
      res.attachment(`BVBRC_${req.call_collection}.gbk`)
    }

    try {
      // Determine genome ID from request
      let genomeId = null

      if (req.call_collection === 'genome') {
        // Direct genome query - get ID from results or params
        if (res.results?.response?.docs?.[0]?.genome_id) {
          genomeId = res.results.response.docs[0].genome_id
        } else if (req.call_params?.[1]) {
          genomeId = req.call_params[1]
        }
      } else if (req.call_collection === 'genome_feature') {
        // Feature query - extract genome_id from query or first result
        if (res.results?.response?.docs?.[0]?.genome_id) {
          genomeId = res.results.response.docs[0].genome_id
        }
      }

      if (!genomeId) {
        res.status(400).send('Genome ID is required for Genbank export')
        return
      }

      debug(`Generating Genbank for genome: ${genomeId}`)

      // Fetch all required data in parallel
      const [genome, contigs, featuresByAccession] = await Promise.all([
        fetchGenome(genomeId, req),
        fetchContigs(genomeId, req),
        fetchFeatures(genomeId, req)
      ])

      debug(`Fetched: genome=${!!genome}, contigs=${contigs.length}, feature groups=${Object.keys(featuresByAccession).length}`)

      if (contigs.length === 0) {
        res.status(404).send(`No sequence data found for genome ${genomeId}`)
        return
      }

      // Generate Genbank record for each contig
      for (let i = 0; i < contigs.length; i++) {
        const contig = contigs[i]
        const accession = contig.accession || contig.sequence_id
        const features = featuresByAccession[accession] || []

        debug(`Generating record for contig ${accession}: ${features.length} features`)

        const record = generateGenbankRecord(genome, contig, features)
        res.write(record)

        // Add newline between records (but not after the last one)
        if (i < contigs.length - 1) {
          res.write('\n')
        }
      }

      res.end()
    } catch (error) {
      debug(`Genbank serialization error: ${error.message}`)
      next(new Error(`Unable to generate Genbank format: ${error.message}`))
    }
  }
}
