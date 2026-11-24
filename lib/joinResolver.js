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
 *
 * `exclusionMaxIds` — cap on the *deprecated* id list used by the taxon-subtree rewrite
 * (see resolveTaxonomicJoin). Deprecated genomes are rare, so this list is far smaller
 * than the live one, but Viruses still needs ~702,000 ids ≈ 8.7 MB. 400,000 keeps the
 * body near 5 MB.
 */
function getThresholds () {
  const cfg = Config.get('joinResolution') || {}
  return {
    enabled: cfg.enabled !== false,
    rewriteMaxGenomes: cfg.rewriteMaxGenomes === undefined ? 50000 : cfg.rewriteMaxGenomes,
    rejectMaxGenomes: cfg.rejectMaxGenomes === undefined ? 150000 : cfg.rejectMaxGenomes,
    countCacheTtlMs: cfg.countCacheTtlMs === undefined ? 300000 : cfg.countCacheTtlMs,
    idCacheTtlMs: cfg.idCacheTtlMs === undefined ? 300000 : cfg.idCacheTtlMs,
    cacheMaxEntries: cfg.cacheMaxEntries === undefined ? 200 : cfg.cacheMaxEntries,
    // Taxon-subtree rewrite (§4.1a of Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md).
    // Off by default: it changes which Solr query a broad taxon runs, and wants shaking
    // down on alpha before it is the default anywhere.
    taxonomicRewrite: cfg.taxonomicRewrite === true,
    exclusionMaxIds: cfg.exclusionMaxIds === undefined ? 400000 : cfg.exclusionMaxIds,
    subtreeMaxTaxa: cfg.subtreeMaxTaxa === undefined ? 250000 : cfg.subtreeMaxTaxa
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
    // Stable tag for clients to branch on. The `message` is the English rendering and
    // stays authoritative for display; `errorCode` is what code should test, so the
    // wording can be improved without breaking anyone. app.js copies both out, along
    // with the fields in its ERROR_DETAIL_FIELDS allowlist.
    this.errorCode = 'join_too_broad'
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

/* ------------------------------------------------------------------------ *
 * Taxon-subtree rewrite with deprecated-genome exclusion.
 *
 * The plain rewrite above resolves a join to a `genome_id` list, which only works below
 * ~50,000 genomes: Influenza A's live set is ~20 MB of ids, and `Limiter` caps the fetch
 * at 50,000 so it cannot even see the whole thing.
 *
 * For a *purely taxonomic* filter there is a much cheaper formulation. `genome_sequence`
 * and `genome_feature` both carry `taxon_id` (the LEAF taxon), so the subtree can be
 * expressed directly, and the only non-taxonomic part of the common filter —
 * `!genome_status:Deprecated` — can be subtracted as a negative id list. That works
 * because deprecated genomes are RARE:
 *
 *     taxon            deprecated      live      excl body   incl body
 *     Influenza A         324,140   1,631,578       4.0 MB     20.2 MB
 *     Bacteria             65,412   1,316,755       0.8 MB     16.3 MB
 *     Viruses             702,579  14,940,472       8.7 MB    185.2 MB
 *     SARS-CoV-2           26,222   9,396,322       0.3 MB    116.5 MB
 *
 * Measured on E. coli against the join as ground truth (Docs/BROAD-TAXON-JOIN-COLD-BUILD):
 *
 *     join (ground truth)            21,789,712    25,097 ms
 *     taxon terms only               22,807,582     1,786 ms   <- over-counts
 *     taxon terms - deprecated ids   21,789,712     1,770 ms   <- EXACT, 14x
 *
 * and on Influenza A, where the join cannot complete at all (3/3 timeouts at 125 s), the
 * exclusion form answers in 9,807 ms.
 *
 * WHY NOT SUBTRACT TAXON IDS INSTEAD OF GENOME IDS
 * Because deprecation is not taxon-aligned. Of the 162 taxa in the Influenza A subtree
 * holding deprecated genomes, 159 are MIXED — live and deprecated together — covering
 * 324,132 of 324,140. Dropping whole taxa would be wrong by essentially the entire set.
 * ------------------------------------------------------------------------ */

// `taxon_lineage_ids:NNN`, optionally parenthesised, optionally ANDed with a
// genome_status exclusion written either as `!genome_status:Deprecated` or
// `-genome_status:Deprecated`. Anything else is not "purely taxonomic" and is left to the
// genome_id path — deliberately strict, because a filter we mis-parse produces a silently
// wrong row count rather than an error.
const TAXONOMIC_RE = /^\(?\s*taxon_lineage_ids:(\d+)\s*(?:AND\s+[!-]genome_status:(\w+)\s*)?\)?$/i

/**
 * Parse a join filter into {taxonId, excludeStatus} if it is purely taxonomic.
 * Returns null when the filter carries anything this rewrite cannot express.
 */
function parseTaxonomicFilter (filter) {
  if (!filter) return null
  const m = TAXONOMIC_RE.exec(filter.trim())
  if (!m) return null
  return { taxonId: m[1], excludeStatus: m[2] || null }
}

/**
 * `rows=0` count against an arbitrary collection, sharing the count cache.
 *
 * Separate from countGenomes because that one is keyed on a join filter and hardcodes the
 * genome collection; this takes an explicit cache key so taxonomy counts and
 * deprecated-genome counts cannot collide with it or with each other.
 */
async function countMatching (queryFn, cache, cacheKey, filter) {
  const { countCacheTtlMs, cacheMaxEntries } = getThresholds()
  const cached = cacheGet(cache, cacheKey, countCacheTtlMs)
  if (cached !== undefined) {
    debug(`count cache hit for ${cacheKey}: ${cached}`)
    return cached
  }
  const results = await queryFn({
    query: `q=*:*&fq=${encodeURIComponent(filter)}&rows=0`
  })
  const count = (results && results.response && results.response.numFound) || 0
  cacheSet(cache, cacheKey, count, cacheMaxEntries)
  debug(`counted ${count} for ${cacheKey}`)
  return count
}

/**
 * Fetch every descendant taxon id of `taxonId`, including itself.
 *
 * Cursor-paged because a broad subtree is large (112,721 taxa for Influenza A) and a
 * single rows=N fetch would hit the same row caps the genome path does.
 */
async function fetchSubtreeTaxa (queryTaxonomy, taxonId, maxTaxa) {
  const { idCacheTtlMs, cacheMaxEntries } = getThresholds()
  const key = `subtree:${taxonId}`
  const cached = cacheGet(idCache, key, idCacheTtlMs)
  if (cached !== undefined) {
    debug(`subtree cache hit for ${taxonId}: ${cached.length} taxa`)
    return cached
  }

  const out = []
  let cursor = '*'
  for (;;) {
    const results = await queryTaxonomy({
      query: `q=*:*&fq=lineage_ids:${encodeURIComponent(taxonId)}&fl=taxon_id` +
             `&rows=20000&sort=taxon_id+asc&cursorMark=${encodeURIComponent(cursor)}`
    })
    const docs = (results && results.response && results.response.docs) || []
    for (const d of docs) {
      if (d.taxon_id !== undefined && d.taxon_id !== null) out.push(String(d.taxon_id))
    }
    const next = results && results.nextCursorMark
    if (!docs.length || !next || next === cursor) break
    cursor = next
    if (out.length > maxTaxa) {
      debug(`subtree for ${taxonId} exceeds ${maxTaxa} taxa; abandoning rewrite`)
      return null
    }
  }
  cacheSet(idCache, key, out, cacheMaxEntries)
  debug(`fetched ${out.length} subtree taxa for ${taxonId}`)
  return out
}

/**
 * Fetch the genome ids to EXCLUDE — those matching the status the filter negates.
 * Cursor-paged for the same reason as the subtree.
 */
async function fetchExcludedGenomeIds (queryGenome, taxonId, status, maxIds) {
  const { idCacheTtlMs, cacheMaxEntries } = getThresholds()
  const key = `excl:${taxonId}:${status}`
  const cached = cacheGet(idCache, key, idCacheTtlMs)
  if (cached !== undefined) {
    debug(`exclusion cache hit for ${taxonId}/${status}: ${cached.length} ids`)
    return cached
  }

  const fq = `taxon_lineage_ids:${taxonId} AND genome_status:${status}`
  const out = []
  let cursor = '*'
  for (;;) {
    const results = await queryGenome({
      query: `q=*:*&fq=${encodeURIComponent(fq)}&fl=genome_id` +
             `&rows=20000&sort=genome_id+asc&cursorMark=${encodeURIComponent(cursor)}`
    })
    const docs = (results && results.response && results.response.docs) || []
    for (const d of docs) {
      if (d.genome_id) out.push(String(d.genome_id))
    }
    const next = results && results.nextCursorMark
    if (!docs.length || !next || next === cursor) break
    cursor = next
    if (out.length > maxIds) {
      debug(`exclusion list for ${taxonId} exceeds ${maxIds} ids; abandoning rewrite`)
      return null
    }
  }
  cacheSet(idCache, key, out, cacheMaxEntries)
  debug(`fetched ${out.length} excluded genome ids for ${taxonId}/${status}`)
  return out
}

/**
 * Build the replacement fq pair for a purely taxonomic join, or null to fall through.
 *
 * Emits, as a single replacement for the join clause:
 *
 *     &fq={!terms f=taxon_id cache=…}<subtree taxa>
 *     &fq=-{!terms f=genome_id cache=…}<deprecated genome ids>
 *
 * The second is omitted when the filter negates no status, or when nothing in the subtree
 * carries that status.
 */
async function resolveTaxonomicJoin (join, parsed, opts, thresholds) {
  const { queryGenome, queryTaxonomy, filterCache } = opts
  if (typeof queryTaxonomy !== 'function') return null

  // SIZE THE WORK BEFORE DOING IT. Both lists are cursor-paged at 20,000 per page, so
  // discovering a cap by hitting it is expensive: Viruses (10239) is 274,702 subtree taxa
  // and 702,579 deprecated genomes, and without this pre-check it burned 13 taxonomy
  // round trips — ~260,000 ids fetched and discarded — before abandoning a query that was
  // always going to be refused for its 14.9M live genomes. Two rows=0 counts cost one
  // round trip each and are cached on the same key the lists use.
  const taxaCount = await countMatching(queryTaxonomy, countCache,
    `taxa:${parsed.taxonId}`, `lineage_ids:${parsed.taxonId}`)
  if (taxaCount > thresholds.subtreeMaxTaxa) {
    debug(`subtree for ${parsed.taxonId} is ${taxaCount} taxa, over ${thresholds.subtreeMaxTaxa}; not rewriting`)
    return null
  }
  if (parsed.excludeStatus) {
    const exclCount = await countMatching(queryGenome, countCache,
      `exclcount:${parsed.taxonId}:${parsed.excludeStatus}`,
      `taxon_lineage_ids:${parsed.taxonId} AND genome_status:${parsed.excludeStatus}`)
    if (exclCount > thresholds.exclusionMaxIds) {
      debug(`exclusion for ${parsed.taxonId} is ${exclCount} ids, over ${thresholds.exclusionMaxIds}; not rewriting`)
      return null
    }
  }

  const taxa = await fetchSubtreeTaxa(queryTaxonomy, parsed.taxonId, thresholds.subtreeMaxTaxa)
  if (!taxa || taxa.length === 0) return null

  let excluded = []
  if (parsed.excludeStatus) {
    excluded = await fetchExcludedGenomeIds(
      queryGenome, parsed.taxonId, parsed.excludeStatus, thresholds.exclusionMaxIds)
    // null means the list blew the cap despite the pre-check — the counts can move
    // between the two queries. Falling through to the join is the safe answer, because
    // emitting the subtree WITHOUT the exclusion would silently over-count.
    if (excluded === null) return null
  }

  const d = cacheDirective(filterCache)
  let replacement = `&fq={!terms f=taxon_id ${d}}${taxa.join(',')}`
  if (excluded.length > 0) {
    replacement += `&fq=-{!terms f=genome_id ${d}}${excluded.join(',')}`
  }
  return { replacement, taxaCount: taxa.length, excludedCount: excluded.length }
}

/**
 * Whether to cache the emitted filter.
 *
 * `true` when the caller will re-send it (grid paging, cursor download), `false` for a
 * one-shot. Measured on E. coli, genome_sequence:
 *
 *   cursorMark, 12 pages x 1000 : 786 ms/page cached vs 1,017 uncached
 *   start=, 8 pages x 25        : 180 ms       cached vs   381 uncached
 *
 * Defaults to cached when the caller says nothing, because the two mistakes are not
 * symmetric: caching a one-shot pays one DocSet build, while not caching a paged query
 * rebuilds on every page, across potentially 60+ of them.
 *
 * NOTE this is the opposite of the `terms()` emitter in lib/solrjs/rql.js, which is
 * rightly cache=false — that one serves one-shot client-written id lists racing a scored
 * q=. Measured here with a scored q= present, cached still won (778 vs 937 ms median),
 * because the taxon subtree is far more selective than the accompanying clause.
 */
function cacheDirective (filterCache) {
  return filterCache === false ? 'cache=false' : 'cache=true'
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
 * @param {Function} [opts.queryTaxonomy] - same, against `taxonomy`; enables the
 *                                          taxon-subtree rewrite
 * @param {boolean} [opts.filterCache] - caller's paging intent; see cacheDirective
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

    // The taxon-subtree rewrite is tried FIRST, and deliberately before the reject: the
    // broad taxa the reject exists to refuse are exactly the ones this handles. Influenza
    // A is 1.6M genomes — far over rejectMaxGenomes — and resolves here in ~3.6s against a
    // join that cannot complete at all.
    if (thresholds.taxonomicRewrite) {
      const parsed = parseTaxonomicFilter(join.filter)
      if (parsed) {
        let taxonomic = null
        try {
          taxonomic = await resolveTaxonomicJoin(join, parsed, opts, thresholds)
        } catch (e) {
          // Fail open to the paths below, exactly as the middleware fails open to the
          // untouched join. A lookup blip must not turn into a rejected request.
          debug(`taxonomic rewrite failed for ${join.filter}: ${e && e.message}`)
        }
        if (taxonomic) {
          out = out.replace(join.match, taxonomic.replacement)
          rewrites.push({
            filter: join.filter,
            toField: 'taxon_id',
            strategy: 'taxon-subtree',
            genomeCount: count,
            taxaCount: taxonomic.taxaCount,
            excludedCount: taxonomic.excludedCount
          })
          console.log(`[JoinRewrite] collection=${collection || 'unknown'} filter=${join.filter} ` +
            `genomes=${count} -> {!terms f=taxon_id} ${taxonomic.taxaCount} taxa` +
            (taxonomic.excludedCount ? ` minus ${taxonomic.excludedCount} ${parsed.excludeStatus} genomes` : ''))
          continue
        }
      }
    }

    if (count > thresholds.rejectMaxGenomes) {
      // The OOM guard. Refuse rather than let Solr try.
      throw new JoinTooBroadError(
        `This query matches ${count.toLocaleString()} genomes, which is too many to ` +
        `process (limit ${thresholds.rejectMaxGenomes.toLocaleString()}). ` +
        'Please narrow the filter — for example, choose a more specific taxon.',
        {
          genomeCount: count,
          limit: thresholds.rejectMaxGenomes,
          filter: join.filter,
          // Present only when the filter was purely taxonomic, which is the case a UI can
          // actually act on — it can offer the child taxa. A filter like
          // `genome_status:Complete` has no taxon to name, and the field is omitted
          // rather than guessed at.
          taxonId: (parseTaxonomicFilter(join.filter) || {}).taxonId
        }
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

    // Cache directive follows the caller's paging intent — see cacheDirective. This used
    // to be an unconditional cache=false, carried over from the terms() analysis in
    // CLAUDE.md; that finding is about a one-shot id list racing a scored q=, and does not
    // describe a client paging through the same filter 10-60 times.
    const replacement = `&fq={!terms f=${join.toField} ${cacheDirective(opts.filterCache)}}${ids.join(',')}`
    out = out.replace(join.match, replacement)
    rewrites.push({
      filter: join.filter,
      toField: join.toField,
      strategy: 'genome-ids',
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
  parseTaxonomicFilter,
  fetchSubtreeTaxa,
  fetchExcludedGenomeIds,
  cacheDirective,
  clearCaches,
  getThresholds,
  JoinTooBroadError
}
