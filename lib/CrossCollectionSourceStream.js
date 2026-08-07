/**
 * Cross-Collection Source Stream
 *
 * Phase 3 of PLAN_CROSS_COLLECTION_DOWNLOAD.md.
 *
 * Resolves a query against a SOURCE collection into a stream of documents from a
 * TARGET collection, in bounded batches:
 *
 *   cursor source(filter, select(linkField))  ──► batch of N link values
 *     ──► {!terms f=<linkField>} on target    ──► push target docs downstream
 *         (prefetch the next source batch while the current one is consumed)
 *
 * The output is an ordinary object-mode Readable of target documents, which is
 * exactly what `res.results.stream` already is for a direct query. That is
 * deliberate: every media serializer (protein+fasta, dna+fasta, gff, csv, …)
 * consumes it unchanged, so cross-collection support does not have to be wired
 * into each one. It also means `gff` — a cross-collection redirect that is not a
 * FASTA format — falls out for free rather than needing separate handling.
 *
 * PERMISSIONS: both sides are scoped independently. The source cursor carries the
 * `permissionFq` computed by CrossCollectionSource; the target fetch computes its
 * own from the target collection. Neither inherits the other's — they are
 * different collections with potentially different publicFree status.
 *
 * Memory is bounded by (batchSize x doc size) regardless of how many source rows
 * match: link values are never accumulated into one big list, which is the whole
 * point of moving this off the client.
 */

const { Readable } = require('stream')
const debug = require('debug')('p3api-server:cross-source-stream')
const { permissionContext } = require('./permissionFilter')
const Config = require('../config')

const DEFAULT_BATCH_SIZE = 2000

/**
 * Build a Solr sort clause valid for cursorMark: the caller's sort (if any) with
 * the collection's uniqueKey appended as a tie breaker.
 *
 * @param {string} [requestedSort] - e.g. 'genome_id asc'
 * @param {string} uniqueKey - The collection's Solr uniqueKey
 * @returns {string} Sort clause guaranteed to contain the uniqueKey
 */
function buildCursorSort (requestedSort, uniqueKey) {
  if (!requestedSort) return `${uniqueKey} asc`

  const fields = requestedSort.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/[\s+]+/)[0])

  if (fields.indexOf(uniqueKey) >= 0) return requestedSort
  return `${requestedSort}, ${uniqueKey} asc`
}

class CrossCollectionSourceStream extends Readable {
  /**
   * @param {Object} options
   * @param {Object} options.solrClient - DirectSolrClient for source + target queries
   * @param {string} options.sourceCollection - Collection the filter applies to
   * @param {string} options.targetCollection - Collection to emit documents from
   * @param {string} options.linkField - Field on source holding target keys
   * @param {string} options.targetKeyField - Field on target matched against linkField
   * @param {string} options.sourceQuery - Solr query string for the source (q/fq/sort)
   * @param {string} [options.sourcePermissionFq] - Permission fq for the source
   * @param {string} [options.targetFl] - Field list to request from the target
   * @param {number} [options.batchSize] - Link values resolved per round trip
   * @param {Object} [options.ctx] - { user, publicFree } for target scoping
   */
  constructor (options = {}) {
    super({ objectMode: true, highWaterMark: 16 })

    const required = ['solrClient', 'sourceCollection', 'targetCollection', 'linkField']
    for (const key of required) {
      if (!options[key]) throw new Error(`CrossCollectionSourceStream: ${key} is required`)
    }

    this.solrClient = options.solrClient
    this.sourceCollection = options.sourceCollection
    this.targetCollection = options.targetCollection
    this.linkField = options.linkField
    this.targetKeyField = options.targetKeyField || options.linkField
    // Accept either a single fq string (`sourceQuery`, convenient for tests) or
    // the q + fq[] split that CrossCollectionSource produces from the raw RQL.
    this.sourceQ = options.sourceQ || '*:*'
    this.sourceFq = options.sourceFq
      ? (Array.isArray(options.sourceFq) ? options.sourceFq.slice() : [options.sourceFq])
      : []
    if (options.sourceQuery) this.sourceFq.push(options.sourceQuery)
    this.sourcePermissionFq = options.sourcePermissionFq || null
    this.targetFl = options.targetFl || null
    this.batchSize = options.batchSize || DEFAULT_BATCH_SIZE
    this.ctx = options.ctx || {}

    // Target-side permission scoping, resolved once (the collection is fixed).
    const { permissionFq } = permissionContext({
      collection: this.targetCollection,
      user: this.ctx.user,
      publicFree: this.ctx.publicFree
    })
    this.targetPermissionFq = permissionFq

    // Cursor pagination requires a sort ending in the collection's uniqueKey.
    // Callers may pass their own sort (the grid's ordering); the uniqueKey is
    // appended if absent rather than replacing it.
    const uniqueKeys = Config.get('collectionUniqueKeys') || {}
    const uniqueKey = uniqueKeys[this.sourceCollection]
    if (!uniqueKey) {
      throw new Error(
        `CrossCollectionSourceStream: no uniqueKey configured for '${this.sourceCollection}'; ` +
        'cursor pagination is not possible (see collectionUniqueKeys in config.js)')
    }
    this.sourceSort = buildCursorSort(options.sourceSort, uniqueKey)

    this.cursorMark = '*'
    this.sourceExhausted = false
    this.pending = []          // target docs ready to push
    this.reading = false
    this.prefetch = null       // in-flight next source batch
    this.stopped = false

    // Link values already resolved, across ALL batches. Per-batch dedup is not
    // enough: the source is sorted by its uniqueKey, not by the link field, so
    // rows sharing a link value scatter across pages. Without this, a feature
    // with sp_gene rows in two pages is emitted twice — duplicate FASTA records.
    // (Measured on real data: 1793 sp_gene rows -> 1708 per-batch-deduped values
    // but only 965 distinct.)
    //
    // Memory is O(distinct link values) of short strings. That is the one thing
    // here that grows with result size — but it is strictly less than the client
    // approach this replaces, which materialized the same set in the browser AND
    // shipped it back inside the request. Nothing else in the pipeline scales
    // with match count.
    this.seenLinkValues = new Set()

    this.stats = {
      sourceRows: 0,           // source rows seen
      linkValues: 0,           // distinct link values resolved
      duplicatesSkipped: 0,    // link values already seen in an earlier batch
      targetDocs: 0,           // target docs emitted
      batches: 0
    }

    debug(`created: ${this.sourceCollection}.${this.linkField} -> ` +
          `${this.targetCollection}.${this.targetKeyField} batchSize=${this.batchSize}`)
  }

  /**
   * Fetch one page of link values from the source using cursor pagination.
   *
   * Cursor (not start/rows) because the source result set can be millions of rows
   * and deep paging with offsets degrades badly. Solr requires the sort to include
   * the uniqueKey for cursorMark — the caller supplies that in sourceQuery.
   *
   * @returns {Promise<Array<string>>} Distinct link values (may be empty)
   * @private
   */
  async _fetchSourceBatch () {
    if (this.sourceExhausted) return []

    const params = {
      q: this.sourceQ,
      fl: this.linkField,
      rows: this.batchSize,
      cursorMark: this.cursorMark,
      // cursorMark requires a sort containing the uniqueKey, or Solr 400s.
      sort: this.sourceSort,
      user: this.ctx.user
    }

    const fq = this.sourceFq.slice()
    if (this.sourcePermissionFq) fq.push(this.sourcePermissionFq)
    if (fq.length) params.fq = fq

    const response = await this.solrClient.queryWithCursor(this.sourceCollection, params)
    const docs = (response && response.response && response.response.docs) || []
    const nextCursor = response && response.nextCursorMark

    this.stats.sourceRows += docs.length

    // Solr signals exhaustion by returning the same cursorMark it was given.
    if (!nextCursor || nextCursor === this.cursorMark || docs.length === 0) {
      this.sourceExhausted = true
    } else {
      this.cursorMark = nextCursor
    }

    // Dedup within the batch AND against everything resolved so far. A smaller
    // {!terms} list is a cheaper target query, and cross-batch dedup is what
    // keeps a document from being emitted twice (see seenLinkValues).
    const values = new Set()
    const take = (x) => {
      if (x === undefined || x === null || x === '') return
      if (this.seenLinkValues.has(x)) {
        this.stats.duplicatesSkipped++
        return
      }
      this.seenLinkValues.add(x)
      values.add(x)
    }

    for (const doc of docs) {
      const v = doc[this.linkField]
      if (Array.isArray(v)) {
        v.forEach(take)
      } else {
        take(v)
      }
    }

    return Array.from(values)
  }

  /**
   * Fetch the target documents for a batch of link values.
   *
   * @param {Array<string>} linkValues
   * @returns {Promise<Array<Object>>}
   * @private
   */
  async _fetchTargetDocs (linkValues) {
    if (linkValues.length === 0) return []

    this.stats.linkValues += linkValues.length

    const docs = await this.solrClient.fetchByIds(
      this.targetCollection,
      this.targetKeyField,
      linkValues,
      {
        fl: this.targetFl,
        permissionFq: this.targetPermissionFq,
        user: this.ctx.user
      }
    )

    return docs
  }

  /**
   * Resolve one source batch into target docs, kicking off the next source fetch
   * before awaiting the target query so the two overlap.
   *
   * @returns {Promise<Array<Object>>}
   * @private
   */
  async _nextBatch () {
    const linkValues = this.prefetch
      ? await this.prefetch
      : await this._fetchSourceBatch()
    this.prefetch = null

    if (linkValues.length === 0) {
      return []
    }

    // Start the next source page now; it overlaps the target round trip.
    if (!this.sourceExhausted) {
      this.prefetch = this._fetchSourceBatch().catch((err) => {
        debug(`Prefetch failed: ${err.message}`)
        this.sourceExhausted = true
        return []
      })
    }

    const docs = await this._fetchTargetDocs(linkValues)
    this.stats.batches++
    debug(`batch ${this.stats.batches}: ${linkValues.length} link values -> ${docs.length} target docs`)

    return docs
  }

  /**
   * Readable implementation. Pulls batches until it has something to push or the
   * source is exhausted; respects backpressure by only working when asked.
   */
  _read () {
    if (this.reading || this.stopped) return

    if (this.pending.length > 0) {
      this.push(this.pending.shift())
      this.stats.targetDocs++
      return
    }

    this.reading = true

    const pump = async () => {
      // A batch of link values can legitimately resolve to zero target docs (all
      // filtered by permissions, or dangling references), so keep going rather
      // than ending the stream on the first empty batch.
      while (!this.stopped) {
        const docs = await this._nextBatch()

        if (docs.length > 0) {
          this.pending = docs
          return true
        }

        if (this.sourceExhausted && !this.prefetch) {
          return false
        }
      }
      return false
    }

    pump().then((hasMore) => {
      this.reading = false
      if (this.stopped) return

      if (!hasMore) {
        debug(`complete: ${this.stats.sourceRows} source rows, ${this.stats.linkValues} link values, ` +
              `${this.stats.targetDocs} target docs in ${this.stats.batches} batches`)
        this.push(null)
        return
      }

      this.push(this.pending.shift())
      this.stats.targetDocs++
    }).catch((err) => {
      this.reading = false
      debug(`Stream error: ${err.message}`)
      this.destroy(err)
    })
  }

  _destroy (err, callback) {
    this.stopped = true
    this.pending = []
    // Let any in-flight prefetch settle rather than leaving an unhandled rejection.
    if (this.prefetch) this.prefetch.catch(() => {})
    this.prefetch = null
    callback(err)
  }

  getStats () {
    return { ...this.stats }
  }
}

module.exports = CrossCollectionSourceStream
module.exports.buildCursorSort = buildCursorSort
module.exports.DEFAULT_BATCH_SIZE = DEFAULT_BATCH_SIZE
