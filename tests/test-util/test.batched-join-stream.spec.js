/**
 * BatchedJoinStream — bulk downloads whose join is too broad for a single filter.
 *
 * Offline; both Solr calls are stubs. What is pinned is the batching contract. The
 * numbers that justify the design were measured against live Solr and are in the
 * module header.
 *
 * The cases that matter most are the ones where being wrong is SILENT: dropping the
 * caller's other fq clauses (returns more rows than asked for), omitting the leading
 * metadata doc (every serializer loses its first record), and continuing to pump after
 * the client disconnects (a 748-batch walk for a response nobody reads).
 */

const assert = require('chai').assert
const BatchedJoinStream = require('../../lib/BatchedJoinStream')

/**
 * Stub a genome collection of `total` ids, cursor-paged, plus a target that returns
 * `perGenome` docs for each id in the slice.
 */
function stubs ({ total = 10, perGenome = 2 } = {}) {
  const calls = { genome: [], target: [] }
  let served = 0
  return {
    calls,
    queryGenome: async ({ query }) => {
      calls.genome.push(query)
      const m = /rows=(\d+)/.exec(query)
      const rows = m ? parseInt(m[1], 10) : 10
      const remaining = Math.max(0, total - served)
      const n = Math.min(rows, remaining)
      const docs = Array.from({ length: n }, (_, i) => ({ genome_id: `g${served + i}` }))
      served += n
      return {
        response: { numFound: total, docs },
        // A distinct mark while rows remain, then repeat it to signal exhaustion.
        nextCursorMark: served >= total ? 'END' : `c${served}`
      }
    },
    queryTarget: async ({ query }) => {
      calls.target.push(query)
      // The fq is URL-encoded, so decode before splitting -- ids arrive as %2C-joined
      // and the local param braces as %7B/%7D.
      const raw = (/fq=([^&]*)/.exec(query) || [])[1] || ''
      const fq = decodeURIComponent(raw)
      const ids = fq.includes('}') ? fq.split('}')[1].split(',').filter(Boolean) : []
      const n = ids.length
      return {
        response: {
          numFound: n * perGenome,
          docs: Array.from({ length: n * perGenome }, (_, i) => ({ id: `d${i}` }))
        }
      }
    }
  }
}

function drain (stream) {
  return new Promise((resolve, reject) => {
    const out = []
    stream.on('data', (d) => out.push(d))
    stream.on('end', () => resolve(out))
    stream.on('error', reject)
  })
}

describe('BatchedJoinStream', function () {
  it('walks the genome cursor in slices and emits every target doc', async function () {
    const s = stubs({ total: 25, perGenome: 2 })
    const docs = await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'taxon_lineage_ids:10239',
      genomeBatch: 10
    }))
    // 25 genomes in slices of 10 -> 3 target fetches; 25 x 2 docs, plus the leading
    // metadata document.
    assert.equal(s.calls.target.length, 3)
    assert.equal(docs.length, 25 * 2 + 1)
  })

  it('emits a leading metadata document', async function () {
    // Serializers skip the first doc (streamWithBackpressure's skipFirstDoc defaults
    // true). Without one, every serializer silently loses its first real record.
    const s = stubs({ total: 2, perGenome: 1 })
    const docs = await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome, queryTarget: s.queryTarget, genomeFilter: 'x:1'
    }))
    assert.isTrue(docs[0]._batchedJoin)
  })

  it('CARRIES the caller\'s other fq clauses into every batch', async function () {
    // Dropping these returns more rows than the request described — silently, as a
    // perfectly well-formed download.
    const s = stubs({ total: 5, perGenome: 1 })
    await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'x:1',
      extraFq: ['public:true', 'feature_type:CDS'],
      genomeBatch: 5
    }))
    const q = s.calls.target[0]
    assert.include(decodeURIComponent(q), 'public:true')
    assert.include(decodeURIComponent(q), 'feature_type:CDS')
  })

  it('passes fl through when given', async function () {
    const s = stubs({ total: 2, perGenome: 1 })
    await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'x:1',
      fl: 'genome_id,patric_id'
    }))
    assert.include(decodeURIComponent(s.calls.target[0]), 'fl=genome_id,patric_id')
  })

  it('uses cache=false — each slice is seen exactly once', async function () {
    // The opposite of lib/joinResolver.js's paging default, and deliberately so: a
    // cached DocSet for a slice never reused is pure cost, and evicts entries that
    // repeated queries depend on.
    const s = stubs({ total: 2, perGenome: 1 })
    await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome, queryTarget: s.queryTarget, genomeFilter: 'x:1'
    }))
    assert.include(decodeURIComponent(s.calls.target[0]), 'cache=false')
  })

  it('targets the join\'s to= field, not always genome_id', async function () {
    const s = stubs({ total: 2, perGenome: 1 })
    await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'x:1',
      toField: 'gid'
    }))
    assert.include(decodeURIComponent(s.calls.target[0]), '{!terms f=gid')
  })

  it('terminates on an empty genome set without querying the target', async function () {
    const s = stubs({ total: 0 })
    const docs = await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome, queryTarget: s.queryTarget, genomeFilter: 'x:1'
    }))
    assert.equal(s.calls.target.length, 0)
    assert.equal(docs.length, 1, 'just the metadata doc')
  })

  it('requests a generous target row cap — a genome maps to MANY docs', async function () {
    // Defaulting rows to the id count is the one-to-one assumption that truncated a
    // 105-contig download to 2 records in the cross-collection work.
    const s = stubs({ total: 3, perGenome: 1 })
    await drain(new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'x:1',
      targetRows: 50000
    }))
    assert.include(s.calls.target[0], 'rows=50000')
  })

  describe('the caller\'s row limit', function () {
    // Live failure, alpha 2026-10-28: a limit(100) CSV download of Bacteria returned
    // HTTP 524 after 125s having emitted ZERO bytes. maxRows was never passed, so the
    // stream walked all 1,316,755 genomes -- 264 slices -- before the serializer could
    // write anything, and Cloudflare cut it first. A fast 400 had become a slow dead end.
    it('stops walking once maxRows is satisfied', async function () {
      const s = stubs({ total: 1000000, perGenome: 1 })
      const docs = await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome,
        queryTarget: s.queryTarget,
        genomeFilter: 'taxon_lineage_ids:2',
        genomeBatch: 1000,
        maxRows: 100
      }))
      assert.isAtMost(docs.length, 102, 'must not stream the whole taxon')
      assert.equal(s.calls.genome.length, 1, 'ONE genome slice, not 1000')
      assert.equal(s.calls.target.length, 1)
    })

    it('caps the TARGET fetch to the outstanding rows, not just the walk', async function () {
      // The second half of the 2026-10-28 failure, and the half the first fix missed.
      // Stopping the genome walk early is not enough if each slice still asks Solr for
      // 50,000 documents: Bacteria's first slice of 20,000 genomes matches 3,635,755
      // sequences, so Solr materialised 50,000 full docs before the serializer saw a
      // row, and Cloudflare cut the response at 125s having emitted nothing.
      const s = stubs({ total: 100000, perGenome: 1 })
      await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome,
        queryTarget: s.queryTarget,
        genomeFilter: 'taxon_lineage_ids:2',
        genomeBatch: 20000,
        targetRows: 50000,
        maxRows: 100
      }))
      const rows = parseInt(/rows=(\d+)/.exec(s.calls.target[0])[1], 10)
      assert.equal(rows, 100, 'must ask for 100 docs, not 50,000')
    })

    it('still asks for the generous cap when unbounded', async function () {
      // One-to-many is real: defaulting rows to the id count truncated a 105-contig
      // download to 2 records in the cross-collection work.
      const s = stubs({ total: 5, perGenome: 1 })
      await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome,
        queryTarget: s.queryTarget,
        genomeFilter: 'x:1',
        targetRows: 50000
      }))
      assert.include(s.calls.target[0], 'rows=50000')
    })

    it('streams the whole set when no limit is given', async function () {
      const s = stubs({ total: 25, perGenome: 2 })
      const docs = await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome,
        queryTarget: s.queryTarget,
        genomeFilter: 'x:1',
        genomeBatch: 10
      }))
      assert.equal(docs.length, 25 * 2 + 1)
    })

    it('ignores a nonsensical limit rather than emitting nothing', async function () {
      for (const bad of [0, -5, NaN, undefined]) {
        const s = stubs({ total: 10, perGenome: 1 })
        const docs = await drain(new BatchedJoinStream({
          queryGenome: s.queryGenome,
          queryTarget: s.queryTarget,
          genomeFilter: 'x:1',
          maxRows: bad || undefined
        }))
        assert.isAbove(docs.length, 1, `maxRows=${bad} must not silence the stream`)
      }
    })
  })

  it('defaults to the measured-optimal genome batch size', function () {
    // 20,000, not 5,000: summing Solr QTime across slices on H5N1 gave ~5.0s at 20,000
    // against ~24.6s at 5,000 -- a 5x penalty that is all per-request overhead.
    assert.equal(BatchedJoinStream.DEFAULT_GENOME_BATCH, 20000)
  })

  it('stops pumping when destroyed mid-stream', async function () {
    const s = stubs({ total: 10000, perGenome: 1 })
    const st = new BatchedJoinStream({
      queryGenome: s.queryGenome,
      queryTarget: s.queryTarget,
      genomeFilter: 'x:1',
      genomeBatch: 100
    })
    await new Promise((resolve) => {
      let n = 0
      st.on('data', () => { if (++n === 50) { st.destroy(); resolve() } })
      st.on('error', resolve)
    })
    const after = s.calls.genome.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(s.calls.genome.length, after, 'must not keep walking the cursor')
  })

  it('fetches through a function the caller supplies, not a bound client', function () {
    // Guards the design note in the header. DirectSolrClient.fetchByIds is NOT a valid
    // substitute here: it queries ONE replica on the assumption that "any shard should
    // have the full dataset", which is true for feature_sequence and false for
    // genome_sequence (12 shards) and genome_feature (80). Swapping it in would return a
    // fraction of a download as a well-formed file. Keeping the fetch injectable is what
    // makes that a deliberate choice rather than an accident -- and what lets this be
    // tested offline at all.
    const st = new BatchedJoinStream({
      queryGenome: async () => ({ response: { docs: [] } }),
      queryTarget: async () => ({ response: { docs: [] } }),
      genomeFilter: 'x:1'
    })
    assert.isFunction(st.queryGenome)
    assert.isFunction(st.queryTarget)
    st.destroy()
  })

  describe('determinism — the caller\'s sort', function () {
    /**
     * A target that behaves like a real sharded collection: UNSORTED fetches come back in
     * an arbitrary order that differs per call (internal docid order, replica-dependent),
     * while a sorted fetch is honoured. Combined with a `rows` cap this is what made the
     * same download return different rows every time.
     */
    // Shared ACROSS stubs on purpose: the real instability is between REQUESTS (a
    // different replica answers, segments merged in between), so a counter that reset
    // per stub would make every run start from the same rotation and the negative
    // control below would pass for the wrong reason.
    let flip = 0

    function unstableTarget ({ perGenome = 4 } = {}) {
      const calls = []
      return {
        calls,
        queryTarget: async ({ query }) => {
          calls.push(query)
          const q = decodeURIComponent(query)
          const ids = q.includes('}') ? q.split('}')[1].split('&')[0].split(',').filter(Boolean) : []
          const rows = parseInt((/rows=(\d+)/.exec(query) || [])[1], 10) || 10
          // The full candidate set for this slice, in canonical order.
          const all = []
          for (const g of ids) for (let i = 0; i < perGenome; i++) all.push({ id: `${g}:${i}` })
          // A replica would not hand them over in that order. Rotate per call.
          const shifted = all.slice(flip % (all.length || 1)).concat(all.slice(0, flip % (all.length || 1)))
          flip++
          const ordered = /[&?]sort=/.test(query)
            ? all.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            : shifted
          return { response: { numFound: all.length, docs: ordered.slice(0, rows) } }
        }
      }
    }

    const run = (sort) => {
      const g = stubs({ total: 6 }).queryGenome
      const t = unstableTarget({ perGenome: 4 })
      return drain(new BatchedJoinStream({
        queryGenome: g,
        queryTarget: t.queryTarget,
        genomeFilter: 'taxon_lineage_ids:10239',
        genomeBatch: 3,
        maxRows: 8,
        sort
      })).then((docs) => docs.filter((d) => !d._batchedJoin).map((d) => d.id))
    }

    it('returns the SAME rows on every run when a sort is given', async function () {
      // The defect, measured on alpha 2026-10-28: three runs of one limit(5000) Viruses
      // download returned 5000 records each with ~75% of the ids DIFFERING between runs.
      // Correct count, well-formed file, different data -- nothing flags it.
      const a = await run('id asc')
      const b = await run('id asc')
      const c = await run('id asc')
      assert.deepEqual(b, a, 'repeat downloads must be identical')
      assert.deepEqual(c, a, 'repeat downloads must be identical')
    })

    it('is NOT reproducible without one — the stub proves the hazard is real', async function () {
      // Guards the guard: if this ever starts passing, the stub stopped modelling
      // replica-order instability and the test above proves nothing.
      const a = await run(undefined)
      const b = await run(undefined)
      assert.notDeepEqual(b, a)
    })

    it('passes the sort to Solr on every slice, not just the first', async function () {
      const g = stubs({ total: 9 }).queryGenome
      const t = unstableTarget({ perGenome: 1 })
      await drain(new BatchedJoinStream({
        queryGenome: g,
        queryTarget: t.queryTarget,
        genomeFilter: 'x:1',
        genomeBatch: 3,
        sort: 'feature_id asc'
      }))
      assert.isAbove(t.calls.length, 1, 'want several slices')
      for (const q of t.calls) {
        assert.include(decodeURIComponent(q), 'sort=feature_id asc')
      }
    })

    it('omits sort entirely when the caller gave none', async function () {
      const s = stubs({ total: 2, perGenome: 1 })
      await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome, queryTarget: s.queryTarget, genomeFilter: 'x:1'
      }))
      assert.notInclude(s.calls.target[0], 'sort=')
    })

    it('encodes a multi-field sort rather than splitting the query string', async function () {
      // 'a asc,b desc' contains a comma and spaces; unencoded it would corrupt the
      // parameter and Solr would reject or silently mis-sort.
      const s = stubs({ total: 2, perGenome: 1 })
      await drain(new BatchedJoinStream({
        queryGenome: s.queryGenome,
        queryTarget: s.queryTarget,
        genomeFilter: 'x:1',
        sort: 'genome_id asc,feature_id asc'
      }))
      const raw = (/sort=([^&]*)/.exec(s.calls.target[0]) || [])[1]
      assert.equal(decodeURIComponent(raw), 'genome_id asc,feature_id asc')
      assert.notInclude(raw, ' ')
    })
  })

  it('surfaces a lookup failure as a stream error, not a truncated success', async function () {
    // A download that silently stops early is this codebase's characteristic failure.
    const s = stubs({ total: 100, perGenome: 1 })
    const boom = async () => { throw new Error('solr exploded') }
    const st = new BatchedJoinStream({
      queryGenome: s.queryGenome, queryTarget: boom, genomeFilter: 'x:1'
    })
    try {
      await drain(st)
      assert.fail('expected an error')
    } catch (e) {
      assert.include(e.message, 'solr exploded')
    }
  })
})
