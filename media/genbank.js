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
 * Usage (request against the genome collection):
 *   GET /genome/?eq(genome_id,GENOME_ID)&http_accept=application/genbank
 *   GET /genome/?in(genome_id,(ID1,ID2,...))&http_download=true&http_accept=application/genbank
 *
 * The serializer only needs the genome_id list from the query and fetches
 * genome metadata, contigs, and features itself. Requesting GenBank from a
 * feature-level collection (genome_feature) is rejected by a guard in
 * routes/dataType.js because it would stream millions of feature docs just to
 * recover the genome_id list.
 *
 * Options (via query parameters):
 *   http_genbank_merged=true - Merge all contigs into a single record
 *                              (useful for tools like Artemis)
 */

const debug = require('debug')('p3api-server:media:genbank')
// Dedicated timing namespace so it can be toggled independently of the verbose
// per-contig debug output: DEBUG=p3api-server:media:genbank:timing
const timing = require('debug')('p3api-server:media:genbank:timing')
const Solrjs = require('../lib/solrjs')
const Config = require('../config')
const { Transform } = require('stream')
const Web = require('../web')

const SOLR_URL = Config.get('solr').url

// --- Solr fetch tuning (diagnostic / mitigation knobs) ---------------------
// GENBANK_SOLR_KEEPALIVE=0 gives the genbank fetches their own agent with
// keepAlive DISABLED. Use this to A/B test the stale-keepalive-socket theory:
// if the multi-minute fetch stalls vanish with keepalive off, a pooled socket
// the server had already dropped was the cause.
// GENBANK_SOLR_TIMEOUT_MS (default 30000) aborts a Solr request that accepts
// but never responds, turning a ~166s hang into a prompt error. Set 0 to
// disable the timeout entirely.
const GENBANK_SOLR_KEEPALIVE = process.env.GENBANK_SOLR_KEEPALIVE !== '0'
const GENBANK_SOLR_TIMEOUT_MS = process.env.GENBANK_SOLR_TIMEOUT_MS !== undefined
  ? parseInt(process.env.GENBANK_SOLR_TIMEOUT_MS, 10)
  : 30000

// Dedicated non-keepalive agent, built lazily only when keepalive is disabled.
let noKeepAliveAgent = null
function getGenbankSolrAgent () {
  if (GENBANK_SOLR_KEEPALIVE) {
    // Default: share the standard pooled agent (same as APIMethodHandler).
    return Web.getSolrAgent()
  }
  if (!noKeepAliveAgent) {
    const isHttps = SOLR_URL.startsWith('https:')
    const mod = isHttps ? require('https') : require('http')
    // Mirror the TLS posture of the shared agent (self-signed Solr certs).
    const opts = { keepAlive: false, maxSockets: 8 }
    if (isHttps) opts.rejectUnauthorized = false
    noKeepAliveAgent = new mod.Agent(opts)
    timing('genbank Solr fetches using NON-keepAlive agent')
  }
  return noKeepAliveAgent
}

// Milliseconds elapsed since an hrtime.bigint() mark. Uses a monotonic clock so
// it is unaffected by wall-clock adjustments (and safe under --frozen intrinsics
// that block Date.now in some contexts).
function msSince (startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6
}

/**
 * Query a Solr collection with structured params.
 * Uses the standard Solrjs client (works through the Solr proxy URL,
 * no direct replica access required).
 */
// One retry after a timeout. A stale keepAlive socket fails fast on the second
// try because the pool discards the destroyed socket and dials a fresh one — so
// a retry both survives the transient hang and confirms the socket theory (the
// retry succeeds quickly). Set GENBANK_SOLR_RETRIES=0 to disable.
const GENBANK_SOLR_RETRIES = process.env.GENBANK_SOLR_RETRIES !== undefined
  ? parseInt(process.env.GENBANK_SOLR_RETRIES, 10)
  : 1

async function solrQuery (collection, params) {
  const parts = []
  parts.push('q=' + encodeURIComponent(params.q || '*:*'))
  parts.push('rows=' + (params.rows || 10))
  if (params.start) parts.push('start=' + params.start)
  if (params.sort) parts.push('sort=' + encodeURIComponent(params.sort))
  if (params.fl) parts.push('fl=' + encodeURIComponent(params.fl))

  if (params.fq) {
    const fqs = Array.isArray(params.fq) ? params.fq : [params.fq]
    for (const f of fqs) {
      parts.push('fq=' + encodeURIComponent(f))
    }
  }

  const query = parts.join('&')
  debug(`solrQuery ${collection}: ${query}`)

  let lastErr
  for (let attempt = 0; attempt <= GENBANK_SOLR_RETRIES; attempt++) {
    const solrClient = new Solrjs(SOLR_URL + '/' + collection)
    solrClient.setAgent(getGenbankSolrAgent())
    if (GENBANK_SOLR_TIMEOUT_MS) {
      solrClient.timeout = GENBANK_SOLR_TIMEOUT_MS
    }
    try {
      const t0 = process.hrtime.bigint()
      const result = await solrClient.query(query)
      if (attempt > 0) {
        timing(`solrQuery ${collection} SUCCEEDED on retry ${attempt} in ${msSince(t0).toFixed(0)}ms`)
      }
      return result
    } catch (err) {
      lastErr = err
      timing(`solrQuery ${collection} attempt ${attempt} failed: ${err.message}`)
      if (attempt >= GENBANK_SOLR_RETRIES) break
    }
  }
  throw lastErr
}

async function solrFetchGenomeMetadata (genomeIds, fields) {
  const termsFilter = '{!terms f=genome_id}' + genomeIds.join(',')
  const result = await solrQuery('genome', {
    fq: termsFilter,
    fl: fields.join(','),
    rows: genomeIds.length
  })
  const dict = {}
  for (const doc of (result.response?.docs || [])) {
    if (doc.genome_id) dict[doc.genome_id] = doc
  }
  return dict
}

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
 * Write a chunk to the response, honoring backpressure. Resolves immediately if
 * the internal buffer has room, otherwise waits for 'drain' (or client 'close').
 * Without this, GenBank's many small writes accumulate unbounded in the Node
 * heap whenever the client/network drains slower than we generate — which on a
 * large multi-genome export leads to GC thrashing and multi-minute stalls.
 */
function writeChunk (res, chunk) {
  return new Promise((resolve) => {
    // If the client has already gone, don't write (and never wait for a 'drain'
    // that will never fire on a dead socket — that was an infinite hang).
    if (res.writableEnded || res.destroyed) {
      resolve(false)
      return
    }
    if (res.write(chunk)) {
      resolve(true)
      return
    }
    const onDrain = () => { cleanup(); resolve(true) }
    const onClose = () => { cleanup(); resolve(false) }
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

/**
 * Build the Genbank record header (LOCUS through FEATURES line) as a string.
 */
function buildRecordHeader (genome, contig) {
  const seqLength = contig.length || contig.sequence?.length || 0
  const accession = contig.accession || contig.sequence_id || 'unknown'
  const topology = contig.topology || 'linear'
  const moleculeType = 'DNA'
  const division = 'BCT'
  const date = formatGenbankDate(contig.release_date || genome.completion_date)

  const lines = []

  // LOCUS line — pad to 16 for alignment but do not truncate longer names
  const locusName = accession.padEnd(16)
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

  return lines.join('\n') + '\n'
}

/**
 * Build pre-fetched features (already scoped to one contig) as a string,
 * ordered by start coordinate.
 */
function buildFeaturesForContig (features) {
  const sorted = features.slice().sort((a, b) => (a.start || 0) - (b.start || 0))
  let out = ''
  for (const feature of sorted) {
    const gbType = mapFeatureType(feature.feature_type)
    out += formatFeature(feature, gbType) + '\n'
  }
  return { text: out, count: sorted.length }
}

/**
 * Build the ORIGIN section with sequence as a string.
 */
function buildOrigin (sequence) {
  if (sequence) {
    return formatOrigin(sequence) + '\n'
  }
  return 'ORIGIN\n//\n'
}

/**
 * Write all GenBank records for one genome from pre-fetched data (multi-record
 * mode). Formatting is synchronous (no Solr I/O), but writes honor backpressure
 * per contig so memory stays bounded on slow clients.
 */
async function writeGenbankMultiRecord (res, genome, contigs, featuresByAccession) {
  let contigCount = 0
  let formatMs = 0 // synchronous record-building time (blocks the event loop)
  let writeMs = 0 // time awaiting res.write backpressure (client drain)
  let bytes = 0

  for (const contig of contigs) {
    const accession = contig.accession || contig.sequence_id

    const fmtStart = process.hrtime.bigint()
    let record = contigCount > 0 ? '\n' : ''
    record += buildRecordHeader(genome, contig)

    const features = featuresByAccession[accession] || []
    const built = buildFeaturesForContig(features)
    record += built.text
    debug(`Wrote ${built.count} features for contig ${accession}`)

    record += buildOrigin(contig.sequence)
    formatMs += msSince(fmtStart)
    bytes += record.length

    const wrStart = process.hrtime.bigint()
    const ok = await writeChunk(res, record)
    writeMs += msSince(wrStart)
    contigCount++
    if (!ok) {
      // Client disconnected — stop writing this genome.
      break
    }
  }

  return { contigCount, formatMs, writeMs, bytes }
}

/**
 * Fetch all Solr data for one genome — metadata, contigs, and features — in a
 * single parallel wave. Collapses what were two serial round-trip waves
 * (genome, then contigs+features) into one.
 */
async function fetchGenomeData (genomeId) {
  // Time each sub-fetch independently so a hang can be attributed to a specific
  // collection (genome / genome_sequence / genome_feature) rather than the
  // combined Promise.all wait.
  const t0 = process.hrtime.bigint()
  let gMs, cMs, fMs
  const [genome, contigs, featuresByAccession] = await Promise.all([
    fetchGenome(genomeId).then((r) => { gMs = msSince(t0); return r }),
    fetchContigs(genomeId).then((r) => { cMs = msSince(t0); return r }),
    fetchFeatures(genomeId).then((r) => { fMs = msSince(t0); return r })
  ])
  // Only log when something is slow enough to matter (avoids per-genome noise).
  const slowest = Math.max(gMs, cMs, fMs)
  if (slowest > 1000) {
    timing(`fetchGenomeData ${genomeId} SLOW: genome=${gMs.toFixed(0)}ms genome_sequence=${cMs.toFixed(0)}ms genome_feature=${fMs.toFixed(0)}ms`)
  }
  return { genome, contigs, featuresByAccession }
}

const GENOME_FIELDS = ['genome_id', 'genome_name', 'organism_name', 'taxon_id', 'taxon_lineage_names', 'strain', 'bioproject_accession', 'biosample_accession', 'completion_date', 'comments']

async function fetchGenome (genomeId) {
  const dict = await solrFetchGenomeMetadata([genomeId], GENOME_FIELDS)
  return dict[genomeId] || {}
}

async function fetchContigs (genomeId) {
  const result = await solrQuery('genome_sequence', {
    fq: 'genome_id:' + genomeId,
    rows: 10000,
    sort: 'accession asc'
  })
  return result.response?.docs || []
}

const FEATURE_FIELDS = 'accession,feature_type,start,end,strand,patric_id,refseq_locus_tag,gene,product,protein_id,figfam_id,pgfam_id,plfam_id,aa_sequence_md5'

function groupFeaturesByAccession (docs) {
  const featuresByAccession = {}
  for (const feature of docs) {
    const acc = feature.accession || 'unknown'
    if (!featuresByAccession[acc]) {
      featuresByAccession[acc] = []
    }
    featuresByAccession[acc].push(feature)
  }
  return featuresByAccession
}

async function fetchFeatures (genomeId) {
  const result = await solrQuery('genome_feature', {
    fq: ['genome_id:' + genomeId, '-feature_type:source'],
    rows: 100000,
    fl: FEATURE_FIELDS
  })
  return groupFeaturesByAccession(result.response?.docs || [])
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

  // LOCUS line — pad to 16 for alignment but do not truncate longer names
  const locusName = accession.padEnd(16)
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

    // Disable nginx proxy buffering so res.write() backpressure reflects the
    // real client drain rate end-to-end (otherwise nginx buffers unboundedly).
    if (res.set) {
      res.set('X-Accel-Buffering', 'no')
    }

    try {
      // Check if merged format is requested
      const genbankParams = req.genbankParams || {}
      const isMerged = genbankParams.http_genbank_merged === 'true' ||
                       genbankParams.http_genbank_merged === true

      // Collect genome IDs to process.
      // In streaming mode (http_download=true), res.results has { stream }
      // instead of { response: { docs } }, so we consume the stream.
      let genomeIds = []
      const results = await Promise.resolve(res.results)

      if (results?.response?.docs && results.response.docs.length > 0) {
        genomeIds = results.response.docs
          .map(doc => doc.genome_id)
          .filter(id => id)
        genomeIds = [...new Set(genomeIds)]
      } else if (results?.stream) {
        genomeIds = await new Promise((resolve, reject) => {
          const ids = new Set()
          let isHeader = true
          results.stream.on('data', (doc) => {
            if (isHeader) { isHeader = false; return }
            if (doc && doc.genome_id) { ids.add(doc.genome_id) }
          })
          results.stream.on('end', () => resolve([...ids]))
          results.stream.on('error', reject)
        })
      } else if (req.call_params?.[1]) {
        genomeIds = [req.call_params[1]]
      }

      if (genomeIds.length === 0) {
        if (!res.headersSent) {
          res.status(400).send('Genome ID is required for Genbank export')
        }
        return
      }

      debug(`Generating Genbank for ${genomeIds.length} genome(s): ${genomeIds.slice(0, 5).join(', ')}${genomeIds.length > 5 ? '...' : ''}`)

      let isFirstGenome = true
      let totalContigs = 0

      // Timing accumulators (ms). fetchWait = time blocked waiting on Solr that
      // the prefetch pipeline did NOT hide; format = synchronous record-building
      // (blocks the event loop); write = time awaiting client drain
      // (backpressure). Summarized per request under the :timing namespace.
      const reqStart = process.hrtime.bigint()
      let fetchWaitMs = 0
      let formatMs = 0
      let writeMs = 0
      let totalBytes = 0

      // Pipeline: prefetch the next genome's Solr data (one parallel wave per
      // genome) while formatting/writing the current one. Formatting is pure
      // CPU, so this overlaps network latency across genomes.
      let nextFetch = fetchGenomeData(genomeIds[0])

      for (let i = 0; i < genomeIds.length; i++) {
        const genomeId = genomeIds[i]
        const waitStart = process.hrtime.bigint()
        const { genome, contigs, featuresByAccession } = await nextFetch
        const thisFetchWait = msSince(waitStart)
        fetchWaitMs += thisFetchWait

        // Kick off the next genome's fetch before writing this one.
        nextFetch = i + 1 < genomeIds.length
          ? fetchGenomeData(genomeIds[i + 1])
          : null
        // Mark the in-flight prefetch as handled so a write error in this
        // iteration doesn't orphan it into an unhandled rejection. The real
        // await at the top of the next iteration still surfaces any error.
        if (nextFetch) nextFetch.catch(() => {})

        // Stop early if the client has disconnected — no point fetching and
        // formatting the remaining genomes into a dead socket.
        if (res.writableEnded || res.destroyed) {
          debug(`Client disconnected, stopping after ${i} genome(s)`)
          break
        }

        if (contigs.length === 0) {
          debug(`No sequence data found for genome ${genomeId}, skipping`)
          continue
        }

        // Add newline separator between genomes (records within a genome are
        // already separated). Only emitted once we know this genome has output.
        if (!isFirstGenome) {
          const sepStart = process.hrtime.bigint()
          await writeChunk(res, '\n')
          writeMs += msSince(sepStart)
        }
        isFirstGenome = false

        if (isMerged) {
          // Merged mode: concatenate all contigs into a single record
          debug(`Generating merged Genbank record for genome ${genomeId}`)
          const fmtStart = process.hrtime.bigint()
          const record = generateMergedGenbankRecord(genome, contigs, featuresByAccession)
          const genFmt = msSince(fmtStart)
          formatMs += genFmt
          totalBytes += record.length
          const wrStart = process.hrtime.bigint()
          await writeChunk(res, record)
          const genWrite = msSince(wrStart)
          writeMs += genWrite
          totalContigs++
          timing(`genome ${genomeId} [merged]: fetchWait=${thisFetchWait.toFixed(0)}ms format=${genFmt.toFixed(0)}ms write=${genWrite.toFixed(0)}ms bytes=${record.length} contigs=${contigs.length}`)
        } else {
          // Multi-record mode: one record per contig
          debug(`Writing Genbank records for genome ${genomeId}`)
          const r = await writeGenbankMultiRecord(res, genome, contigs, featuresByAccession)
          formatMs += r.formatMs
          writeMs += r.writeMs
          totalBytes += r.bytes
          totalContigs += r.contigCount
          timing(`genome ${genomeId}: fetchWait=${thisFetchWait.toFixed(0)}ms format=${r.formatMs.toFixed(0)}ms write=${r.writeMs.toFixed(0)}ms bytes=${r.bytes} contigs=${r.contigCount}`)
        }
      }

      const totalMs = msSince(reqStart)
      timing(`REQUEST SUMMARY ${genomeIds.length} genomes, ${totalContigs} contigs, ${(totalBytes / 1048576).toFixed(1)}MiB: ` +
        `total=${totalMs.toFixed(0)}ms fetchWait=${fetchWaitMs.toFixed(0)}ms format=${formatMs.toFixed(0)}ms(CPU) write=${writeMs.toFixed(0)}ms(drain) ` +
        `| format=${(100 * formatMs / totalMs).toFixed(1)}% write=${(100 * writeMs / totalMs).toFixed(1)}% fetchWait=${(100 * fetchWaitMs / totalMs).toFixed(1)}%`)

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
