/**
 * Which genome fields does a FASTA request actually need?
 *
 * THE PROBLEM THIS SOLVES, reported from a GUI session 2026-10-30:
 *
 * `GET /genome_feature/fields` advertises 35 enriched fields, but the FASTA serializers
 * fetched a hardcoded list of 7 (`GenomeMetadataJoinStream.DEFAULT_CONFIG.genomeFields`).
 * Anything else resolved to undefined and was silently dropped from the header:
 *
 *   genome_metadata.strain,genome_metadata.host_name,genome_metadata.isolation_country
 *     -> ">fig|... MGYG-HGUT-00869"          strain only; the other two vanish
 *
 * And a second problem layered on top: NAMING. `/fields` reports bare `host_name`, while
 * FASTA required a `genome_metadata.` prefix — `needsGenomeJoin()` triggers on that
 * literal substring. So a client that correctly consumed `/fields` and passed back the
 * names it was given got nothing at all, including the fields that previously worked:
 *
 *   strain,host_name,isolation_country
 *     -> ">fig|..."                           all three dropped
 *
 * RESOLUTION: bare names are canonical. `select(strain)` already works unprefixed, so
 * the prefix was a FASTA-only wart. Bare names now work everywhere, and the
 * `genome_metadata.` form is still accepted so existing saved URLs and documented
 * examples keep working — it is an alias, not the interface.
 *
 * Fields are resolved against `lib/joinConfig.js`, the same registry `/fields` reports
 * and `JoinEnrichment` uses, so the three cannot disagree. A field the registry does not
 * know is not fetched: that is what stops a typo becoming a wasted `fl` entry, and it
 * keeps the FASTA path from quietly diverging from the rest of the API again.
 */

const { getJoinConfig } = require('./joinConfig')
const { templateFields } = require('../util/fastaHeaderFormatter')

const PREFIX = 'genome_metadata.'

/**
 * Fields always fetched, regardless of what the header asks for.
 *
 * `genome_id` is the join key. The rest are the historical default list, kept so that a
 * request which worked before this change still works — dropping them would be a
 * regression for anyone relying on the old implicit behaviour.
 */
const ALWAYS_FETCH = [
  'genome_id',
  'genome_name',
  'taxon_id',
  'genome_status',
  'strain',
  'assembly_accession',
  'bioproject_accession',
  'biosample_accession'
]

/** Strip the optional `genome_metadata.` prefix from a field reference. */
function bareName (field) {
  const f = String(field || '').trim()
  return f.startsWith(PREFIX) ? f.slice(PREFIX.length) : f
}

/**
 * Every field named across a request's FASTA header parameters.
 *
 * @param {Object} req
 * @returns {Array<string>} bare field names, in request order, deduped
 */
function requestedHeaderFields (req) {
  const p = (req && req.fastaParams) || {}

  // A format string REPLACES the zone parameters (see http_fasta_header in
  // util/fastaHeaderFormatter.js), so when one is present the fields to join are the
  // ones it references -- reading the zone parameters instead would join the wrong set
  // and every templated enriched field would render empty, which is precisely the
  // silent-drop bug this module exists to prevent.
  if (p.http_fasta_header && String(p.http_fasta_header).trim() !== '') {
    return templateFields(String(p.http_fasta_header))
  }

  const raw = [
    p.http_fasta_id_fields,
    p.http_fasta_description_fields,
    p.http_fasta_context_fields
  ]

  const out = []
  for (const group of raw) {
    if (!group || typeof group !== 'string') continue
    for (const part of group.split(',')) {
      const name = bareName(part)
      if (name && !out.includes(name)) out.push(name)
    }
  }
  return out
}

/**
 * Which of a request's header fields come from the `genome` collection?
 *
 * @param {Object} req
 * @param {string} collection - the collection being served
 * @returns {Array<string>} bare genome field names
 */
function requestedGenomeFields (req, collection) {
  const cfg = (getJoinConfig().collections || {})[collection]
  const joinable = (cfg && cfg.joinableFields) || {}

  return requestedHeaderFields(req).filter((name) => {
    const spec = joinable[name]
    // Only single-hop joins from `genome`. A multi-hop spec needs BatchJoiner's chain
    // walker, which this stream does not implement -- claiming support would silently
    // produce empty values, which is the failure being fixed here.
    return !!spec && spec.from === 'genome' && !Array.isArray(spec.path)
  })
}

/**
 * Does this request need genome metadata joined in?
 *
 * True when a header names ANY genome-sourced field, whether bare or prefixed. The old
 * implementation tested only for the literal `genome_metadata.` substring, which is why
 * bare names silently produced no join at all.
 *
 * @param {Object} req
 * @param {string} collection
 * @returns {boolean}
 */
function needsGenomeJoin (req, collection) {
  return requestedGenomeFields(req, collection).length > 0
}

/**
 * The `genomeFields` list to hand GenomeMetadataJoinStream for this request.
 *
 * @param {Object} req
 * @param {string} collection
 * @returns {Array<string>}
 */
function genomeFieldsFor (req, collection) {
  const wanted = requestedGenomeFields(req, collection)
  const all = new Set([...ALWAYS_FETCH, ...wanted])
  return Array.from(all)
}

module.exports = {
  PREFIX,
  ALWAYS_FETCH,
  bareName,
  requestedHeaderFields,
  requestedGenomeFields,
  needsGenomeJoin,
  genomeFieldsFor
}
