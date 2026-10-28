/**
 * BatchedJoinStream — stream a download whose cross-collection join is too broad to
 * express as a single filter.
 *
 * THE PROBLEM
 *
 * middleware/JoinResolution refuses a join whose genome set exceeds `rejectMaxGenomes`
 * (150,000 by default). It sits at routes/dataType.js:263, before `checkIfStreaming`, so
 * it refuses a bulk download on exactly the same terms as a 25-row grid page — including
 * an advanced protein-FASTA download of Viruses, which 400s in 1.5s.
 *
 * For the grid that cap is right. The rewrite it protects resolves the join into ONE
 * `{!terms}` filter, and that filter costs ~25 ms per 1,000 ids with a body that grows
 * linearly: 14.9M genome ids would be a ~190 MB filter, which is not a thing.
 *
 * But a DOWNLOAD does not need one filter. It can resolve in slices, and the measured
 * cost is roughly FLAT in slice size, because the work is proportional to the total id
 * count rather than to how it is cut up (H5N1, 246,835 genomes, genome_sequence):
 *
 *     batch    body    QTime   batches   total
 *       500      5K     25ms       494     12s
 *     2,000     20K     75ms       124      9s
 *     5,000     60K    143ms        50      7s
 *    20,000    265K    391ms        13      5s
 *
 * Projected to Viruses: ~748 batches x ~390 ms ~= 5 minutes of Solr time, with memory and
 * request bodies bounded throughout. Slow, but finite and reliable — which for a bulk
 * download is the right trade. Compare the alternative the user sees today, which is a
 * 400, and the one before that, which was a 120s timeout.
 *
 * WHY NOT REUSE CrossCollectionSourceStream
 *
 * It solves the identical shape (cursor a source, batch into {!terms} against a target,
 * prefetch the next batch while the current drains) and its design notes are worth
 * reading. But it fetches through `DirectSolrClient`, which needs direct network access
 * to every Solr replica. Production HAS that; an off-site dev laptop does not, and
 * neither does anything reaching Solr through a proxy URL. Depending on it would make
 * this path untestable in exactly the environment it gets developed in — the same
 * reasoning that put media/genbank.js on the ordinary client. This goes through
 * `internalQuery` instead, at the cost of duplicating the batching loop.
 *
 * That is a deliberate trade, and `internalQuery` has a second advantage that is easy to
 * miss: Solr's own coordinator fans the {!terms} filter across shards for us, so the
 * per-batch cost measured above ALREADY includes distributed execution.
 *
 * If this is ever revisited for speed, note that `DirectSolrClient.fetchByIds` is NOT a
 * drop-in replacement. It calls `_selectReplica()` and queries exactly ONE replica, on
 * the stated assumption that "any shard should have the full dataset (this is true for
 * non-sharded collections like feature_sequence)". That holds for `feature_sequence`; it
 * is false for `genome_sequence` (12 shards) and `genome_feature` (80), where a single
 * replica holds a fraction of the data. Swapping it in would silently return 1/12th or
 * 1/80th of a download -- a well-formed file, missing most of its contents, which is this
 * codebase's characteristic failure. The real distributed equivalent is
 * `ParallelQueryCoordinator`, which is a different and larger piece of machinery.
 *
 * OUTPUT CONTRACT
 *
 * An object-mode Readable of ordinary target documents, exactly what `res.results.stream`
 * already is. Every media serializer consumes it unchanged.
 */

const { Readable } = require('stream')
const debug = require('debug')('p3api-server:batched-join-stream')

// Genome ids per slice. 20,000 measured fastest end-to-end, but the curve is nearly flat
// from 2,000 upward, and smaller slices mean a smaller request body and smoother
// backpressure. 5,000 is the compromise: ~60 KB per filter, ~143 ms per round trip.
const DEFAULT_GENOME_BATCH = 20000

// Target documents fetched per slice. A genome maps to many sequences or features, so
// this is the real memory bound — it is NOT the genome batch size. Mirrors the
// maxTargetsPerLink reasoning in CrossCollectionSourceStream: being wrong here is silent
// data loss, so err high.
const DEFAULT_TARGET_ROWS = 50000

class BatchedJoinStream extends Readable {
  /**
   * @param {Object} opts
   * @param {Function} opts.queryGenome   async ({query}) => parsed Solr response
   * @param {Function} opts.queryTarget   async ({query}) => parsed Solr response
   * @param {string}   opts.genomeFilter  the join's filter, e.g. 'taxon_lineage_ids:10239'
   * @param {string}   opts.toField       target field holding the genome id
   * @param {string}   [opts.fl]          target field list
   * @param {string}   [opts.extraFq]     the rest of the caller's query (non-join clauses)
   * @param {number}   [opts.genomeBatch]
   * @param {number}   [opts.targetRows]
   */
  constructor (opts = {}) {
    super({ objectMode: true, highWaterMark: 16 })
    this.queryGenome = opts.queryGenome
    this.queryTarget = opts.queryTarget
    this.genomeFilter = opts.genomeFilter
    this.toField = opts.toField || 'genome_id'
    this.fl = opts.fl
    this.extraFq = opts.extraFq || []
    this.genomeBatch = opts.genomeBatch || DEFAULT_GENOME_BATCH
    this.targetRows = opts.targetRows || DEFAULT_TARGET_ROWS
    // The caller's row limit. Without it the genome walk runs to the end of the taxon no
    // matter how few rows were asked for -- a limit(100) download of Bacteria traversed
    // all 1,316,755 genomes and was cut off by Cloudflare at 125s having emitted nothing.
    // Normalise defensively rather than trusting the caller: a negative or non-numeric
    // limit would otherwise satisfy `emitted >= maxRows` immediately and end the stream
    // having emitted nothing -- an empty file with HTTP 200, which is precisely this
    // codebase's characteristic failure. middleware/JoinResolution already filters these,
    // but the class should not depend on that.
    this.maxRows = (typeof opts.maxRows === 'number' && Number.isFinite(opts.maxRows) &&
                    opts.maxRows > 0) ? opts.maxRows : undefined
    this.emitted = 0

    this.cursor = '*'
    this.genomesDone = false
    this.reading = false
    this.destroyedEarly = false
    this.emittedMeta = false
    // Docs fetched but not yet pushed, when a batch hits backpressure mid-way.
    this.pending = []
    this.stats = { genomeBatches: 0, genomeIds: 0, targetDocs: 0 }
  }

  /** Next slice of genome ids, by cursor. Returns [] when the source is exhausted. */
  async _nextGenomeIds () {
    if (this.genomesDone) return []
    const q = `q=*:*&fq=${encodeURIComponent(this.genomeFilter)}&fl=genome_id` +
      `&rows=${this.genomeBatch}&sort=genome_id+asc` +
      `&cursorMark=${encodeURIComponent(this.cursor)}`
    const res = await this.queryGenome({ query: q })
    const docs = (res && res.response && res.response.docs) || []
    const next = res && res.nextCursorMark
    if (!docs.length || !next || next === this.cursor) {
      this.genomesDone = true
    } else {
      this.cursor = next
    }
    const ids = docs.map((d) => d.genome_id).filter(Boolean)
    if (ids.length) {
      this.stats.genomeBatches++
      this.stats.genomeIds += ids.length
    }
    return ids
  }

  /** Target documents for one slice of genome ids. */
  async _fetchTargets (ids) {
    // cache=false deliberately: each slice is seen exactly once, so a cached DocSet is
    // pure cost and would evict entries that repeated queries depend on. This is the
    // one-shot case the terms() analysis in CLAUDE.md describes, unlike the paging case
    // that drove cache=true in lib/joinResolver.js.
    const terms = `{!terms f=${this.toField} cache=false}${ids.join(',')}`

    // Never fetch more than the caller can still use. targetRows must stay generous for
    // an unbounded download -- a genome maps to many sequences, and defaulting to the id
    // count silently truncates a one-to-many fetch -- but asking for 50,000 documents to
    // satisfy a limit(100) is 500x waste on EVERY slice.
    //
    // This is what actually broke the Bacteria download. Its first slice of 20,000
    // genomes matches 3,635,755 sequences, so Solr materialised and returned 50,000 full
    // documents before the serializer saw a single row; Cloudflare cut the response at
    // 125s with zero bytes. Capping the fetch to the outstanding row count turns that
    // first round trip from "50,000 docs" into "100 docs".
    const want = this.maxRows !== undefined
      ? Math.max(1, Math.min(this.targetRows, this.maxRows - this.emitted))
      : this.targetRows
    let q = `q=*:*&fq=${encodeURIComponent(terms)}&rows=${want}`
    for (const fq of this.extraFq) {
      q += `&fq=${encodeURIComponent(fq)}`
    }
    if (this.fl) q += `&fl=${encodeURIComponent(this.fl)}`
    const res = await this.queryTarget({ query: q })
    const docs = (res && res.response && res.response.docs) || []
    this.stats.targetDocs += docs.length
    return docs
  }

  async _pump () {
    if (this.reading || this.destroyedEarly) return
    this.reading = true
    try {
      for (;;) {
        // Drain anything left over from a batch that hit backpressure last time. Without
        // this the unpushed remainder of that batch is lost: _pump would resume by
        // fetching the NEXT slice of genome ids, silently dropping documents mid-file.
        while (this.pending.length) {
          if (this.destroyedEarly) return
          if (this.maxRows !== undefined && this.emitted >= this.maxRows) {
            debug(`row limit ${this.maxRows} reached after ${JSON.stringify(this.stats)}`)
            this.push(null)
            return
          }
          const wantsMore = this.push(this.pending.shift())
          this.emitted++
          if (!wantsMore) return
        }

        const ids = await this._nextGenomeIds()
        if (!ids.length) {
          debug(`done: ${JSON.stringify(this.stats)}`)
          this.push(null)
          return
        }
        this.pending = await this._fetchTargets(ids)
      }
    } catch (err) {
      debug(`failed after ${JSON.stringify(this.stats)}: ${err && err.message}`)
      this.destroy(err)
    } finally {
      this.reading = false
    }
  }

  _read () {
    // Serializers skip the first document, treating it as the stream metadata that
    // solrjs streams emit (streamWithBackpressure's skipFirstDoc defaults true). Emitting
    // one keeps this stream interchangeable with those; without it every serializer
    // silently loses its first record.
    //
    // Do NOT return after pushing it. _read is only called again when the buffer drains,
    // and pushing a single tiny object does not fill it, so returning here stalls the
    // stream before the first batch is ever fetched. Fall through and start pumping.
    if (!this.emittedMeta) {
      this.emittedMeta = true
      this.push({ _batchedJoin: true })
    }
    // _pump is async and self-guarding: Node calls _read again while the first await is
    // still outstanding, and without the guard that starts a second concurrent walk of
    // the same cursor (observed as every batch being fetched twice).
    this._pump()
  }

  _destroy (err, cb) {
    this.destroyedEarly = true
    cb(err)
  }
}

module.exports = BatchedJoinStream
module.exports.DEFAULT_GENOME_BATCH = DEFAULT_GENOME_BATCH
module.exports.DEFAULT_TARGET_ROWS = DEFAULT_TARGET_ROWS
