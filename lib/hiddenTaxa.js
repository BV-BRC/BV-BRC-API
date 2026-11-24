/**
 * Hidden public taxa
 *
 * Hides PUBLIC rows belonging to configured taxonomic subtrees (e.g. the four influenza
 * genera on alpha) from every read path. Rows a caller can see through ownership —
 * owner, user_read, or a configured `publicOwners` account — stay visible. The clause is
 * applied by lib/permissionFilter.js, so it reaches every place the permission filter
 * reaches: the primary query, gets by id, join enrichment, cross-collection downloads,
 * FASTA sequence joins, and the in-process /data summaries.
 *
 * Config (p3api.conf):
 *
 *   "hiddenPublicTaxa": {
 *     "roots": [197911, 197912, 197913, 1511083],
 *     "cacheFile": "/path/to/hidden-taxa.json",   // optional, recommended
 *     "refreshHours": 24,
 *     "collections": { ... }                       // optional override of DEFAULT_COLLECTIONS
 *   }
 *
 * Two ways a collection can be filtered, chosen per collection:
 *
 *   - `taxon_lineage_ids` (genome, and several public reference collections): a document
 *     carries its whole lineage, so the four root ids are enough. Cheap.
 *   - `taxon_id` (genome_feature, genome_sequence, sp_gene, ...): the document knows only
 *     its own taxon, so the filter needs every id in the subtree. For the influenza
 *     genera that is ~131k ids, ~1 MB of filter text. Resolved from the `taxonomy`
 *     collection at startup and refreshed periodically, NOT hardcoded: new strain taxa
 *     arrive with every data load, and a static list would let them through silently.
 *
 * FAILS CLOSED. Until the subtree has been resolved (or loaded from `cacheFile`), a
 * `taxon_id` collection treats EVERY public row as hidden. A worker that cannot reach
 * Solr for the taxonomy query therefore serves no public genome_feature rows rather than
 * serving the ones it was told to hide. `cacheFile` exists so a restart does not open
 * that window.
 *
 * A refresh that comes back much smaller than the list it would replace is rejected
 * (see MAX_SHRINK): a taxonomy collection caught mid-reload must not shrink the filter
 * and leak the difference.
 *
 * Collections not listed are not filtered. `feature_sequence` cannot be (it carries no
 * taxon field); it is keyed by md5 and reachable only from a feature that is itself
 * hidden. `taxonomy` is deliberately absent so the tree itself stays browsable.
 */

const fs = require('fs')
const Config = require('../config')
const debug = require('debug')('p3api-server:hiddenTaxa')

const LINEAGE = 'taxon_lineage_ids'
const TAXON_ID = 'taxon_id'

// Field each collection is filtered on. Derived from alpha's /<collection>/fields
// (2026-11-24): the first group carries taxon_lineage_ids, the second only taxon_id.
const DEFAULT_COLLECTIONS = Object.freeze({
  genome: LINEAGE,
  protein_structure: LINEAGE,
  epitope: LINEAGE,
  surveillance: LINEAGE,
  serology: LINEAGE,
  experiment: LINEAGE,
  bioset: LINEAGE,

  genome_feature: TAXON_ID,
  genome_sequence: TAXON_ID,
  sp_gene: TAXON_ID,
  subsystem: TAXON_ID,
  pathway: TAXON_ID,
  genome_amr: TAXON_ID,
  genome_typing: TAXON_ID,
  sequence_feature: TAXON_ID,
  protein_feature: TAXON_ID
})

// Reject a refresh that would drop more than this fraction of the current list.
const MAX_SHRINK = 0.1

// Solr clause that matches every document: used as the "hidden" set before the subtree
// is known, which makes `public:true AND NOT <clause>` match nothing (fail closed).
const MATCH_ALL = '*:*'

function normalizeIds (value, label) {
  if (value == null || value === '') return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const out = []
  for (const v of list) {
    const s = String(v).trim()
    if (!s) continue
    if (!/^\d+$/.test(s)) {
      throw new Error(`${label}: expected numeric taxon ids, got ${JSON.stringify(v)}`)
    }
    if (out.indexOf(s) < 0) out.push(s)
  }
  return out
}

function normalizeCollections (value) {
  if (value == null) return DEFAULT_COLLECTIONS
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hiddenPublicTaxa.collections: expected an object of collection -> field')
  }
  for (const [c, f] of Object.entries(value)) {
    if (f !== LINEAGE && f !== TAXON_ID) {
      throw new Error(`hiddenPublicTaxa.collections.${c}: field must be ${LINEAGE} or ${TAXON_ID}, got ${JSON.stringify(f)}`)
    }
  }
  return Object.freeze({ ...value })
}

/**
 * Build an immutable filter state. `taxonIds` null means "not resolved yet".
 */
function makeState ({ roots, collections, taxonIds }) {
  const rootList = normalizeIds(roots, 'hiddenPublicTaxa.roots')
  const ids = taxonIds == null ? null : normalizeIds(taxonIds, 'hiddenPublicTaxa taxon ids')
  if (ids) ids.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  return Object.freeze({
    enabled: rootList.length > 0,
    roots: rootList,
    rootSet: new Set(rootList),
    collections: normalizeCollections(collections),
    taxonIds: ids,
    taxonIdSet: ids ? new Set(ids) : null,
    lineageClause: rootList.length ? `${LINEAGE}:(${rootList.join(' OR ')})` : null,
    // ids are digits only, so the quoted local-params string needs no escaping.
    taxonIdClause: ids && ids.length ? `_query_:"{!terms f=${TAXON_ID}}${ids.join(',')}"` : null
  })
}

const cfg = Config.get('hiddenPublicTaxa') || {}
let state = makeState({ roots: cfg.roots, collections: cfg.collections, taxonIds: null })
let refreshTimer = null

function getState () {
  return state
}

/**
 * The Solr clause matching the hidden rows' taxa for `collection`, or null when the
 * collection is not filtered. Returns MATCH_ALL for a taxon_id collection whose subtree
 * is not yet resolved.
 *
 * @param {string} collection
 * @param {Object} [s] - state override (tests)
 * @returns {string|null}
 */
function hiddenTaxaClause (collection, s = state) {
  if (!s.enabled) return null
  const field = s.collections[collection]
  if (field === LINEAGE) return s.lineageClause
  if (field === TAXON_ID) {
    if (!s.taxonIds) return MATCH_ALL
    return s.taxonIdClause // null when the subtree resolved to nothing: nothing to hide
  }
  return null
}

/**
 * Per-document counterpart: does this doc fall in a hidden taxon? Prefers taxon_id
 * (present on nearly every collection), falls back to taxon_lineage_ids.
 *
 * @param {Object} doc
 * @param {string} collection
 * @param {Object} [s] - state override (tests)
 * @returns {boolean}
 */
function isDocInHiddenTaxa (doc, collection, s = state) {
  if (!s.enabled || !doc) return false
  const field = s.collections[collection]
  if (!field) return false

  const tid = doc[TAXON_ID]
  if (tid != null && s.taxonIdSet) return s.taxonIdSet.has(String(tid))

  const lineage = doc[LINEAGE]
  if (Array.isArray(lineage)) return lineage.some((t) => s.rootSet.has(String(t)))

  // A taxon_id collection with an unresolved subtree, or a doc carrying neither field:
  // we cannot tell, so treat it as hidden (fail closed), matching hiddenTaxaClause.
  return field === TAXON_ID || tid != null
}

/**
 * Reset roots/collections and drop any resolved subtree. Tests only; production state
 * comes from p3api.conf at load.
 */
function configure ({ roots, collections } = {}) {
  state = makeState({ roots, collections, taxonIds: null })
  return state
}

/**
 * Replace the resolved subtree. Exposed for tests and for refresh().
 */
function setTaxonIds (taxonIds) {
  state = makeState({ roots: state.roots, collections: state.collections, taxonIds })
  return state
}

function loadCacheFile (file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const fileRoots = normalizeIds(data.roots, 'cacheFile roots').slice().sort().join(',')
    const wantRoots = state.roots.slice().sort().join(',')
    if (fileRoots !== wantRoots) {
      console.warn(`[hiddenTaxa] ignoring ${file}: built for roots ${fileRoots}, configured ${wantRoots}`)
      return false
    }
    setTaxonIds(data.taxonIds)
    console.log(`[hiddenTaxa] loaded ${state.taxonIds.length} taxon ids from ${file} (resolved ${data.resolvedAt || '?'})`)
    return true
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[hiddenTaxa] could not read ${file}: ${err.message}`)
    return false
  }
}

function writeCacheFile (file) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      roots: state.roots,
      resolvedAt: new Date().toISOString(),
      taxonIds: state.taxonIds
    }))
    fs.renameSync(tmp, file) // atomic: concurrent workers never read a partial file
  } catch (err) {
    console.warn(`[hiddenTaxa] could not write ${file}: ${err.message}`)
    try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ }
  }
}

/**
 * Resolve the subtree from the taxonomy collection.
 *
 * @param {Function} [queryTaxonomy] - (solrQueryString) => Promise<solr response>;
 *   defaults to a direct Solr query. Injected by tests.
 * @returns {Promise<boolean>} true when the list was replaced
 */
async function refresh (queryTaxonomy) {
  if (!state.enabled) return false
  const query = queryTaxonomy || defaultQueryTaxonomy
  const q = `q=lineage_ids:(${state.roots.join(' OR ')})&rows=0&facet=true&facet.field=taxon_id` +
    '&facet.limit=-1&facet.mincount=1&facet.sort=index&json.nl=map'

  let body
  try {
    body = await query(q)
  } catch (err) {
    console.error(`[hiddenTaxa] taxonomy query failed: ${err && err.message}`)
    return false
  }
  const facet = body && body.facet_counts && body.facet_counts.facet_fields &&
    body.facet_counts.facet_fields.taxon_id
  if (!facet || typeof facet !== 'object') {
    console.error('[hiddenTaxa] taxonomy query returned no taxon_id facet; keeping current list')
    return false
  }
  const ids = Object.keys(facet)
  // Each root must resolve to at least itself, or the roots are wrong / taxonomy is empty.
  const missingRoots = state.roots.filter((r) => !(r in facet))
  if (missingRoots.length) {
    console.error(`[hiddenTaxa] roots not found in taxonomy: ${missingRoots.join(',')}; keeping current list`)
    return false
  }
  const prev = state.taxonIds
  if (prev && ids.length < prev.length * (1 - MAX_SHRINK)) {
    console.error(`[hiddenTaxa] refresh shrank the list ${prev.length} -> ${ids.length} (> ${MAX_SHRINK * 100}%); keeping current list`)
    return false
  }
  setTaxonIds(ids)
  debug(`resolved ${ids.length} taxon ids under ${state.roots.join(',')}`)
  if (!prev || prev.length !== ids.length) {
    console.log(`[hiddenTaxa] resolved ${ids.length} taxon ids under roots ${state.roots.join(',')}`)
  }
  if (cfg.cacheFile) writeCacheFile(cfg.cacheFile)
  return true
}

function defaultQueryTaxonomy (q) {
  // Required lazily: this module is loaded by lib/permissionFilter.js, which half the
  // codebase requires, and nothing at load time should depend on web.js / solrjs order.
  const Solrjs = require('./solrjs')
  const Web = require('../web')
  const client = new Solrjs(Config.get('solr').url + '/taxonomy')
  client.setAgent(Web.getSolrAgent())
  client.timeout = 120000
  return client.query(q)
}

/**
 * Start-up hook, called once per worker from app.js. Loads the cache file synchronously
 * (so the first request already has the list), then refreshes from Solr now and every
 * `refreshHours`. No-op when no roots are configured.
 */
function start () {
  if (!state.enabled || refreshTimer) return
  console.log(`[hiddenTaxa] hiding public rows under taxa ${state.roots.join(',')} in: ${Object.keys(state.collections).join(', ')}`)
  if (cfg.cacheFile) loadCacheFile(cfg.cacheFile)
  if (!state.taxonIds) {
    console.warn('[hiddenTaxa] subtree not yet resolved: public rows in taxon_id collections are hidden until it is')
  }
  refresh()
  const hours = Number(cfg.refreshHours) > 0 ? Number(cfg.refreshHours) : 24
  refreshTimer = setInterval(() => { refresh() }, hours * 3600 * 1000)
  refreshTimer.unref()
}

module.exports = {
  hiddenTaxaClause,
  isDocInHiddenTaxa,
  makeState,
  getState,
  configure,
  setTaxonIds,
  refresh,
  start,
  DEFAULT_COLLECTIONS,
  MATCH_ALL
}
