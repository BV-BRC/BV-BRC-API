/**
 * Cross-collection join resolution and admission.
 *
 * WHAT THIS IS FOR
 *
 * On 2026-06-25 three Solr data nodes crashed with JVM heap OOM. The cause was
 * `{!join method=crossCollection fromIndex=genome ...}` over a broad taxon: the join
 * materializes every matching genome into a DocSet, per shard, and holds it for the life
 * of the query. `taxon_lineage_ids:2` (all Bacteria) is 1.38M genomes today, and the
 * measured cost curve runs from 2.4s at 14K genomes to a hard timeout at 15.6M:
 *
 *     14,317 genomes ->   2,447 ms        326,888 ->  29,269 ms
 *     119,464        ->  11,893 ms      1,382,167 ->  73,699 ms
 *                                      15,625,500 ->  120s timeout
 *
 * Two mitigations, both implemented here:
 *
 *   1. REJECT a join whose genome set is too large to be safe. This is the actual OOM
 *      prevention — it is the only thing that stops a broad-taxon query reaching Solr.
 *   2. REWRITE a join whose genome set is small enough into `{!terms f=<field>}<ids>`,
 *      resolved locally. Measured 3-6x faster with *identical* numFound: taxon 1386's
 *      14,317 ids returned 129,545,777 either way, in 769ms against the join's 2,447ms.
 *
 * See PLAN_SOLR_OVERLOAD_PROTECTION.md, as corrected by
 * Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md, and Docs/COMPLETION_PLAN-2026-10.md
 * Phase 1.
 *
 * WHY THIS OPERATES ON THE EMITTED SOLR STRING
 *
 * The join is generated inside `lib/solrjs/rql.js`'s `toSolr()`, which is **synchronous**
 * (middleware/RQLQueryParser.js:104). Resolving a genome set requires a Solr round trip,
 * so it cannot happen there. The emitted query string is where all three `toSolr` callers
 * converge on one representation, so that is where this works.
 *
 * WHY THE GENOME LOOKUP IS NOT PERMISSION-FILTERED
 *
 * Deliberate, and it preserves existing behavior exactly. `{!join fromIndex=genome}` today
 * matches genomes irrespective of permission; what protects private data is the permission
 * `fq` that `DecorateQuery` adds to the **outer** query against the target collection. The
 * resolved id list is server-side only and never reaches the client. Adding a permission
 * filter here would change which ids are produced and risk diverging from the join it
 * replaces — a correctness regression dressed as a security improvement. Private rows stay
 * protected by the outer filter either way.
 */

const debug = require('debug')('p3api-server:joinResolver')
const Config = require('../config')

// Matches a crossCollection join clause in an emitted Solr query string. Solr allows the
// joined filter in two places, and BOTH are generated in this codebase:
//
//   lib/solrjs/rql.js:99   &fq={!join ... to=genome_id}taxon_lineage_ids:1386
//   routes/dataRouter.js   &fq={!join ... to=genome_id v=taxon_lineage_ids:10239}
//
// The second puts the filter in a `v=` local param instead of after the closing brace.
// Missing it would leave summary_by_taxon — the endpoint whose 120s timeouts started this
// whole investigation — unprotected, so both forms are matched here.
//
// The trailing filter runs to the next '&' or end of string. A Solr filter can contain a
// literal '&' inside a quoted value; none of the filters this codebase emits do, and the
// consequence of a mismatch is that the join is left intact (fail-open), not that it is
// mangled.
const JOIN_RE = /&fq=\{!join\s+method=crossCollection\s+fromIndex=genome\s+from=(\w+)\s+to=(\w+)(?:\s+v=([^}]*))?\}([^&]*)/g

/**
 * Current thresholds, read per call so config changes do not need a restart.
 *
 * `rewriteMaxGenomes` — at or below this, resolve locally to {!terms}. Bounded by query
 * body size as much as by Solr cost: ids are ~10 bytes, so 50,000 is a ~500KB body. Shard
 * pages are POSTs (see CLAUDE.md), so that is deliverable, but it is not free.
 *
 * `rejectMaxGenomes` — above this, refuse the query with 400. Default 150,000 corresponds
 * to roughly 12-15s by the measured curve. The plan's original 10,000 was calibrated
 * against genome counts that have since roughly doubled and would now reject taxa that
 * complete in 2.4s.
 *
 * Between the two: leave the join alone. It is too big to inline cheaply but not large
 * enough to be dangerous.
 */
function getThresholds () {
  const cfg = Config.get('joinResolution') || {}
  return {
    enabled: cfg.enabled !== false,
    rewriteMaxGenomes: cfg.rewriteMaxGenomes === undefined ? 50000 : cfg.rewriteMaxGenomes,
    rejectMaxGenomes: cfg.rejectMaxGenomes === undefined ? 150000 : cfg.rejectMaxGenomes,
    countCacheTtlMs: cfg.countCacheTtlMs === undefined ? 300000 : cfg.countCacheTtlMs,
    idCacheTtlMs: cfg.idCacheTtlMs === undefined ? 300000 : cfg.idCacheTtlMs,
    cacheMaxEntries: cfg.cacheMaxEntries === undefined ? 200 : cfg.cacheMaxEntries
  }
}

// Two small TTL caches keyed by the genome filter text. Genome counts move only with
// indexing, so a few minutes of staleness is harmless and saves a Solr round trip on the
// common case of a user paging through one taxon.
//
// Not an LRU: the working set is tiny (a handful of taxa in flight) and a size cap with
// oldest-first eviction is enough. Using a real LRU here would be more machinery than the
// access pattern justifies.
const countCache = new Map()
const idCache = new Map()

function cacheGet (cache, key, ttlMs) {
  const hit = cache.get(key)
  if (!hit) {
    return undefined
  }
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key)
    return undefined
  }
  return hit.value
}

function cacheSet (cache, key, value, maxEntries) {
  if (cache.size >= maxEntries) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), value })
}

/** Drop both caches. Tests, and anything that needs a clean read after reindexing. */
function clearCaches () {
  countCache.clear()
  idCache.clear()
}

/**
 * Find every crossCollection join in an emitted Solr query.
 *
 * @param {string} solrQuery
 * @returns {Array<{match: string, fromField: string, toField: string, filter: string}>}
 */
function findJoins (solrQuery) {
  if (!solrQuery || typeof solrQuery !== 'string') {
    return []
  }
  const found = []
  // Fresh regex state per call — JOIN_RE is global and therefore stateful.
  JOIN_RE.lastIndex = 0
  let m
  while ((m = JOIN_RE.exec(solrQuery)) !== null) {
    // Group 3 is the `v=` form, group 4 the trailing form. Exactly one carries the
    // filter; prefer v= when present.
    const vParam = m[3]
    const trailing = m[4]
    const filter = (vParam !== undefined && vParam !== '') ? vParam : trailing
    if (!filter) {
      continue // a join with no filter matches everything; leave it alone rather than guess
    }
    found.push({ match: m[0], fromField: m[1], toField: m[2], filter })
  }
  return found
}

/**
 * An over-broad join, refused before it reaches Solr.
 *
 * Carries `status` (read by app.js's terminal handler) and `statusCode` (read by
 * internalQuery/dataRouter), so it surfaces as a 400 with an actionable message rather
 * than a generic failure.
 */
class JoinTooBroadError extends Error {
  constructor (message, details = {}) {
    super(message)
    this.name = 'JoinTooBroadError'
    this.status = 400
    this.statusCode = 400
    Object.assign(this, details)
  }
}

/**
 * Count genomes matching a filter, and fetch their ids when asked.
 *
 * `queryGenome` is injected rather than imported so this module does not depend on
 * lib/internalQuery — that module must not require anything under middleware/, and
 * keeping the dependency pointing inward avoids re-creating the cycle documented in
 * CLAUDE.md. Callers pass the function; tests pass a stub.
 *
 * @param {Function} queryGenome - async ({query}) => parsed Solr response
 * @param {string} filter - Solr filter text, e.g. 'taxon_lineage_ids:1386'
 * @returns {Promise<number>}
 */
async function countGenomes (queryGenome, filter) {
  const { countCacheTtlMs, cacheMaxEntries } = getThresholds()
  const cached = cacheGet(countCache, filter, countCacheTtlMs)
  if (cached !== undefined) {
    debug(`count cache hit for ${filter}: ${cached}`)
    return cached
  }

  const results = await queryGenome({
    query: `q=*:*&fq=${encodeURIComponent(filter)}&rows=0`
  })
  const count = (results && results.response && results.response.numFound) || 0
  cacheSet(countCache, filter, count, cacheMaxEntries)
  debug(`counted ${count} genomes for ${filter}`)
  return count
}

/**
 * Fetch the genome_id list for a filter.
 *
 * @param {Function} queryGenome
 * @param {string} filter
 * @param {number} expectedCount - from countGenomes; used as the row limit
 * @returns {Promise<string[]>}
 */
async function fetchGenomeIds (queryGenome, filter, expectedCount) {
  const { idCacheTtlMs, cacheMaxEntries } = getThresholds()
  const cached = cacheGet(idCache, filter, idCacheTtlMs)
  if (cached !== undefined) {
    debug(`id cache hit for ${filter}: ${cached.length} ids`)
    return cached
  }

  const results = await queryGenome({
    query: `q=*:*&fq=${encodeURIComponent(filter)}&rows=${expectedCount}&fl=genome_id`
  })
  const docs = (results && results.response && results.response.docs) || []
  const ids = docs.map((d) => d.genome_id).filter((id) => id !== undefined && id !== null)
  cacheSet(idCache, filter, ids, cacheMaxEntries)
  debug(`fetched ${ids.length} genome ids for ${filter}`)
  return ids
}

/**
 * Resolve every crossCollection join in a Solr query.
 *
 * Returns the (possibly rewritten) query, or throws JoinTooBroadError if any join is over
 * the reject threshold.
 *
 * @param {string} solrQuery - emitted Solr query string
 * @param {Object} opts
 * @param {Function} opts.queryGenome - async ({query}) => parsed Solr response
 * @param {string} [opts.collection] - target collection, for logging
 * @returns {Promise<{query: string, rewrites: Array, unchanged: boolean}>}
 */
async function resolveJoins (solrQuery, opts = {}) {
  const thresholds = getThresholds()
  const joins = findJoins(solrQuery)

  if (!thresholds.enabled || joins.length === 0) {
    return { query: solrQuery, rewrites: [], unchanged: true }
  }

  const { queryGenome, collection } = opts
  if (typeof queryGenome !== 'function') {
    // Without a way to count we cannot make a decision. Leaving the join intact
    // preserves today's behavior rather than failing a request that would have worked.
    debug('no queryGenome provided; leaving joins unresolved')
    return { query: solrQuery, rewrites: [], unchanged: true }
  }

  let out = solrQuery
  const rewrites = []

  for (const join of joins) {
    const count = await countGenomes(queryGenome, join.filter)

    if (count > thresholds.rejectMaxGenomes) {
      // The OOM guard. Refuse rather than let Solr try.
      throw new JoinTooBroadError(
        `This query matches ${count.toLocaleString()} genomes, which is too many to ` +
        `process (limit ${thresholds.rejectMaxGenomes.toLocaleString()}). ` +
        'Please narrow the filter — for example, choose a more specific taxon.',
        { genomeCount: count, limit: thresholds.rejectMaxGenomes, filter: join.filter }
      )
    }

    if (count > thresholds.rewriteMaxGenomes) {
      // Too big to inline, not big enough to refuse. Leave the join alone.
      debug(`join left intact: ${count} genomes exceeds rewrite limit ${thresholds.rewriteMaxGenomes}`)
      continue
    }

    if (count === 0) {
      // An empty id list is not expressible as {!terms} — Solr rejects an empty value
      // list — and the join already returns nothing. Leaving it alone is both correct
      // and cheap, since the join over an empty genome set is the trivial case.
      debug('join left intact: filter matches no genomes')
      continue
    }

    const ids = await fetchGenomeIds(queryGenome, join.filter, count)
    if (ids.length === 0) {
      continue
    }

    // cache=false is load-bearing, not a micro-optimization: a cached terms filter makes
    // Solr materialize the DocSet up front and drive iteration from the scored query,
    // which measured 3,952ms against 676ms uncached on a query carrying another clause.
    // See the terms() analysis in CLAUDE.md.
    const replacement = `&fq={!terms f=${join.toField} cache=false}${ids.join(',')}`
    out = out.replace(join.match, replacement)
    rewrites.push({
      filter: join.filter,
      toField: join.toField,
      genomeCount: count,
      idCount: ids.length
    })
    console.log(`[JoinRewrite] collection=${collection || 'unknown'} filter=${join.filter} genomes=${count} -> {!terms f=${join.toField}}`)
  }

  return { query: out, rewrites, unchanged: rewrites.length === 0 }
}

module.exports = {
  resolveJoins,
  findJoins,
  countGenomes,
  fetchGenomeIds,
  clearCaches,
  getThresholds,
  JoinTooBroadError
}
