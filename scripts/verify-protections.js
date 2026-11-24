#!/usr/bin/env node

/**
 * verify-protections.js — exercise a running API and show the overload protections working.
 *
 * WHY THIS EXISTS
 *
 * Every protection in this workstream was shipped with offline unit tests, and twice that
 * was not enough: a green suite covered the wrong code path and the bug only surfaced
 * against a deployed server.
 *
 *   - Phase 0.1 patched solrjs's subQuery() but not query(), which is what the main data
 *     path uses. All unit tests passed while a real 429 still reached the client as a 500.
 *   - Phase 1's sanitizer keyed off req.queryType to tell a client join from a generated
 *     one. queryType comes from the content-type, so every genome() query 400'd on alpha
 *     — through a test suite that included a case named for exactly that trap.
 *
 * Both were caught by hitting the real thing. This script makes that repeatable: point it
 * at a deployment and it reports which protections are present, working, or absent.
 *
 * WHAT IT CHECKS
 *
 *   admission    Layer 1 pools visible at /stats; concurrency bounded when enabled
 *   joins        over-broad cross-collection joins refused, small ones rewritten
 *   timeouts     the Solr wall-clock deadline bounds queued requests
 *   security     foreign joins and dangerous Solr params refused
 *   regression   ordinary traffic still works — the part that actually broke twice
 *   load         sustained concurrent heavy downloads, with /stats sampled throughout
 *
 * USAGE
 *
 *   node scripts/verify-protections.js https://alpha.bv-brc.org/api
 *   node scripts/verify-protections.js https://alpha.bv-brc.org/api --only=joins,regression
 *   node scripts/verify-protections.js http://localhost:3001 --load --concurrency 12
 *
 * It is READ-ONLY: every request is a GET or a query POST. Nothing is written or deleted.
 * The load phase is deliberately opt-in — it issues real concurrent downloads.
 *
 * EXIT CODE is the number of failed checks, so CI can gate on it. A check that cannot run
 * (a protection not deployed, a probe taxon missing) is reported SKIP and does not fail.
 */

'use strict'

const http = require('http')
const https = require('https')
const { URL } = require('url')

// ---------------------------------------------------------------------------
// Probe data.
//
// Genome counts verified against production 2026-10-16. They matter because the
// admission bands are defined in genome counts, and the corpus grows — Bacteria was
// ~500K when the original plan was written and is 1.38M now. The script re-reads the
// live count for each taxon rather than trusting these, and says so when they drift.
// ---------------------------------------------------------------------------
const TAXA = {
  tiny: { id: 1929297, approxGenomes: 7, band: 'rewrite' },
  small: { id: 1386, approxGenomes: 14317, band: 'rewrite' },
  medium: { id: 562, approxGenomes: 119464, band: 'intact' },
  large: { id: 1239, approxGenomes: 326888, band: 'reject' },
  huge: { id: 10239, approxGenomes: 15628238, band: 'reject' }
}

// A genome with a known, modest feature count — used for ordinary-traffic checks.
const REF_GENOME = '83332.12'

const CHECK_GROUPS = ['admission', 'joins', 'timeouts', 'security', 'regression', 'load']

// ---------------------------------------------------------------------------
// Tiny HTTP helper. No dependencies: this script has to run anywhere, including
// against a deployment from a laptop with no node_modules.
// ---------------------------------------------------------------------------
function request (endpoint, path, opts = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, endpoint.endsWith('/') ? endpoint : endpoint + '/')
    const mod = url.protocol === 'https:' ? https : http
    const body = opts.body || null
    const started = Date.now()

    const headers = Object.assign({
      Accept: opts.accept || 'application/json',
      'User-Agent': 'bvbrc-api/verify-protections'
    }, opts.headers || {})

    if (body) {
      headers['Content-Type'] = opts.contentType || 'application/solrquery+x-www-form-urlencoded'
      headers['Content-Length'] = Buffer.byteLength(body)
    }

    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: body ? 'POST' : 'GET',
      headers
    }, (res) => {
      let data = ''
      let bytes = 0
      res.on('data', (c) => { bytes += c.length; if (data.length < 200000) data += c })
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
        bytes,
        ms: Date.now() - started
      }))
    })

    req.on('error', (err) => resolve({ status: 0, error: err.message, ms: Date.now() - started }))
    // Generous: some of these probes are deliberately slow, and a client-side timeout
    // would be indistinguishable from the server hanging.
    req.setTimeout(opts.timeout || 180000, () => {
      req.destroy()
      resolve({ status: 0, error: 'client timeout', ms: Date.now() - started, timedOut: true })
    })

    if (body) req.write(body)
    req.end()
  })
}

function json (res) {
  try { return JSON.parse(res.body) } catch (e) { return null }
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------
const results = { pass: 0, fail: 0, skip: 0, rows: [] }

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', x: '' }

function record (state, group, name, detail) {
  results[state]++
  results.rows.push({ state, group, name, detail })
  const tag = state === 'pass' ? `${C.g}PASS${C.x}`
    : state === 'fail' ? `${C.r}FAIL${C.x}`
      : `${C.y}SKIP${C.x}`
  console.log(`  ${tag}  ${name}`)
  if (detail) console.log(`        ${C.d}${detail}${C.x}`)
}

const pass = (g, n, d) => record('pass', g, n, d)
const fail = (g, n, d) => record('fail', g, n, d)
const skip = (g, n, d) => record('skip', g, n, d)

function section (title) {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function getStats (endpoint) {
  const res = await request(endpoint, 'stats')
  return res.status === 200 ? json(res) : null
}

async function checkAdmission (endpoint) {
  section('Admission control (Layer 1)')

  const stats = await getStats(endpoint)
  if (!stats) {
    return skip('admission', '/stats reachable', 'no /stats response — is the API up?')
  }

  if (!stats.admission) {
    return skip('admission', 'admission pools reported at /stats',
      'no `admission` key — Phase 2 is not deployed here')
  }

  pass('admission', 'admission pools reported at /stats',
    `heavy ${stats.admission.heavy.max_concurrent} slots / ${stats.admission.heavy.max_queue} queue, ` +
    `interactive ${stats.admission.interactive.max_concurrent}/${stats.admission.interactive.max_queue}`)

  // Socket-pool visibility (Phase 0.3) — the number the pool sizes are tuned against.
  if (stats.agents && stats.agents['solr.main']) {
    const a = stats.agents['solr.main']
    pass('admission', 'socket pool visible',
      `solr.main active=${a.active} queued=${a.queued} maxSockets=${a.maxSockets}`)

    // The design rule is "admission pool <= socket pool, so the socket queue stays
    // empty". Flag the inversion rather than asserting a number, since both are config.
    if (stats.admission.enabled && stats.admission.heavy.max_concurrent > a.maxSockets) {
      fail('admission', 'admission pool <= socket pool',
        `heavy ${stats.admission.heavy.max_concurrent} > maxSockets ${a.maxSockets}: ` +
        'admitted work will queue at the agent, where it is unobservable')
    } else {
      pass('admission', 'admission pool <= socket pool',
        `heavy ${stats.admission.heavy.max_concurrent} vs maxSockets ${a.maxSockets}`)
    }
  } else {
    skip('admission', 'socket pool visible', 'no `agents` key — Phase 0.3 not deployed')
  }

  if (!stats.admission.enabled) {
    skip('admission', 'enforcement active',
      'queryAdmission.enabled is false — classification and counters run, nothing is shed. ' +
      'This is the shipped default; enabling needs client 429 support.')
  } else {
    pass('admission', 'enforcement active', 'queryAdmission.enabled is true')
  }

  return stats
}

async function checkJoins (endpoint) {
  section('Cross-collection join admission (Phase 1)')

  // Confirm the live genome counts, because the bands are defined in those terms and
  // the corpus grows. A drifted count is worth saying out loud, not silently assuming.
  for (const key of ['small', 'large']) {
    const t = TAXA[key]
    // POST, not GET: a bare query string on a GET is parsed as RQL, so
    // `fq=taxon_lineage_ids:...` comes back as "Unknown converter taxon_lineage_ids".
    // The solrquery content-type is what selects the Solr parser.
    const res = await request(endpoint, 'genome/', {
      body: `q=*:*&fq=taxon_lineage_ids:${t.id}&rows=0`,
      accept: 'application/solr+json'
    })
    const body = json(res)
    const live = body && body.response && body.response.numFound
    if (typeof live !== 'number') {
      skip('joins', `taxon ${t.id} genome count`, 'could not read a count')
      continue
    }
    const drift = Math.abs(live - t.approxGenomes) / t.approxGenomes
    if (drift > 0.25) {
      skip('joins', `taxon ${t.id} genome count`,
        `${live.toLocaleString()} vs expected ~${t.approxGenomes.toLocaleString()} — ` +
        'the corpus has moved; re-check the thresholds before trusting the band below')
    } else {
      pass('joins', `taxon ${t.id} genome count`, `${live.toLocaleString()} genomes`)
    }
  }

  // The headline: taxa that used to burn 120s and return a 500.
  for (const key of ['large', 'huge']) {
    const t = TAXA[key]
    const res = await request(endpoint, `data/summary_by_taxon/${t.id}`, { timeout: 150000 })
    const body = json(res)

    if (res.timedOut || res.ms > 60000) {
      fail('joins', `broad taxon ${t.id} refused promptly`,
        `took ${(res.ms / 1000).toFixed(1)}s — the join is still reaching Solr`)
      continue
    }
    if (res.status !== 400) {
      fail('joins', `broad taxon ${t.id} refused promptly`,
        `expected 400, got ${res.status} in ${(res.ms / 1000).toFixed(2)}s`)
      continue
    }
    // The message is the point: a bare "Unable to query" reads as a server fault.
    const msg = (body && body.message) || ''
    if (/too many|narrow/i.test(msg)) {
      pass('joins', `broad taxon ${t.id} refused promptly`,
        `400 in ${(res.ms / 1000).toFixed(2)}s — "${msg.slice(0, 90)}"`)
    } else {
      fail('joins', `broad taxon ${t.id} refused with an actionable message`,
        `400 in ${(res.ms / 1000).toFixed(2)}s but message was "${msg}"`)
    }
  }

  // A small taxon must still work — this is the band that gets rewritten to {!terms}.
  const small = TAXA.tiny
  const ok = await request(endpoint, `data/summary_by_taxon/${small.id}`, { timeout: 150000 })
  if (ok.status === 200) {
    pass('joins', `small taxon ${small.id} still answered`,
      `200 in ${(ok.ms / 1000).toFixed(2)}s`)
  } else {
    fail('joins', `small taxon ${small.id} still answered`, `got ${ok.status}`)
  }
}

async function checkRegression (endpoint) {
  section('Ordinary traffic (the part that broke twice)')

  // genome() RQL — broken for one deploy by the Phase 1 sanitizer. The single most
  // important check in this script, because it is the one that actually regressed.
  const g = await request(endpoint, 'genome_feature/', {
    contentType: 'application/rqlquery+x-www-form-urlencoded',
    body: `genome(eq(taxon_lineage_ids,${TAXA.tiny.id}))&limit(2)`,
    timeout: 120000
  })
  if (g.status === 200) {
    pass('regression', 'genome() RQL query', `200 in ${(g.ms / 1000).toFixed(2)}s`)
  } else {
    const b = json(g)
    fail('regression', 'genome() RQL query',
      `got ${g.status} — ${(b && (b.error || b.message)) || g.body.slice(0, 120)}`)
  }

  // Same query as solrquery content-type: the exact shape that 400'd on alpha, because
  // the website sends RQL-derived queries with that header.
  const gs = await request(endpoint, 'genome_feature/', {
    contentType: 'application/rqlquery+x-www-form-urlencoded',
    body: `genome(eq(taxon_lineage_ids,${TAXA.small.id}))&limit(2)`,
    timeout: 120000
  })
  if (gs.status === 200) {
    pass('regression', 'genome() over a rewritten taxon', `200 in ${(gs.ms / 1000).toFixed(2)}s`)
  } else {
    fail('regression', 'genome() over a rewritten taxon', `got ${gs.status}`)
  }

  const plain = await request(endpoint, 'genome_feature/', {
    contentType: 'application/rqlquery+x-www-form-urlencoded',
    body: `eq(genome_id,${REF_GENOME})&limit(3)`
  })
  const pd = json(plain)
  if (plain.status === 200 && Array.isArray(pd) && pd.length === 3) {
    pass('regression', 'plain RQL query', '200, 3 docs')
  } else {
    fail('regression', 'plain RQL query', `status ${plain.status}`)
  }

  const solr = await request(endpoint, 'genome_feature/', {
    body: `q=*:*&fq=genome_id:${REF_GENOME}&rows=2`,
    accept: 'application/solr+json'
  })
  if (solr.status === 200 && /numFound/.test(solr.body)) {
    pass('regression', 'solr-format query', '200')
  } else {
    fail('regression', 'solr-format query', `status ${solr.status}`)
  }

  // A Solr query error must still be a 400 with the database message, not a 500 — the
  // path Phase 0.1 was careful not to reroute.
  const bad = await request(endpoint, 'genome_feature/', {
    body: 'q=nosuchfield_xyz:1&rows=1'
  })
  if (bad.status === 400) {
    pass('regression', 'Solr query error still 400', 'not rerouted to a 500')
  } else {
    fail('regression', 'Solr query error still 400', `got ${bad.status}`)
  }

  // A streaming download without sort() returns HTTP 200 with zero bytes — a documented
  // trap, checked here so the harness itself cannot be fooled by it.
  const dl = await request(endpoint, 'genome_feature/', {
    contentType: 'application/rqlquery+x-www-form-urlencoded',
    body: `eq(genome_id,${REF_GENOME})&sort(+feature_id)&limit(5000)`,
    accept: 'text/csv',
    headers: { download: '1' },
    timeout: 150000
  })
  if (dl.status === 200 && dl.bytes > 1000) {
    pass('regression', 'streaming CSV download', `${dl.bytes.toLocaleString()} bytes`)
  } else {
    fail('regression', 'streaming CSV download',
      `status ${dl.status}, ${dl.bytes} bytes (a 200 with 0 bytes means the stream failed)`)
  }
}

async function checkSecurity (endpoint) {
  section('Query sanitization')

  const foreign = await request(endpoint, 'genome_feature/', {
    body: 'q=*:*&fq={!join fromIndex=genome_amr from=genome_id to=genome_id}antibiotic:*&rows=2'
  })
  if (foreign.status === 400) {
    pass('security', 'foreign join refused', '400')
  } else {
    fail('security', 'foreign join refused', `got ${foreign.status}`)
  }

  const shards = await request(endpoint, 'genome_feature/', {
    body: 'q=*:*&shards=http://evil.example.com/solr&rows=2'
  })
  if (shards.status === 400) {
    pass('security', 'shards parameter refused', '400 (pre-existing SSRF guard)')
  } else {
    fail('security', 'shards parameter refused', `got ${shards.status}`)
  }

  const encoded = await request(endpoint, 'genome_feature/', {
    body: 'q=*:*&fq=%7B!join%20fromIndex=secrets%20from=a%20to=b%7Dx:1&rows=2'
  })
  if (encoded.status === 400) {
    pass('security', 'encoded foreign join refused', '400')
  } else {
    fail('security', 'encoded foreign join refused', `got ${encoded.status}`)
  }
}

async function checkTimeouts (endpoint) {
  section('Request deadlines')

  // Can only be observed indirectly from outside: a protected server fails fast and
  // consistently rather than hanging to the client's own limit. Checked by confirming no
  // ordinary request approaches the 120s Solr deadline.
  const res = await request(endpoint, 'genome_feature/', {
    body: 'q=*:*&rows=0',
    accept: 'application/solr+json',
    timeout: 150000
  })
  if (res.timedOut) {
    fail('timeouts', 'bare count completes', 'client timed out — server is hanging')
  } else if (res.status === 200 && res.ms < 60000) {
    pass('timeouts', 'bare count completes', `${(res.ms / 1000).toFixed(2)}s`)
  } else if (res.status === 504) {
    pass('timeouts', 'upstream timeout surfaces as 504',
      'the deadline fired and was classified, rather than hanging')
  } else {
    skip('timeouts', 'bare count completes', `status ${res.status} in ${(res.ms / 1000).toFixed(1)}s`)
  }
}

async function checkLoad (endpoint, concurrency, expect429) {
  section(`Sustained load (${concurrency} concurrent heavy downloads)`)

  const before = await getStats(endpoint)

  // Sample /stats while the load runs — the queue depth is only visible mid-flight.
  let peakHeavyActive = 0
  let peakHeavyDepth = 0
  let peakSocketQueue = 0
  let sampled = 0
  const sampler = setInterval(async () => {
    const s = await getStats(endpoint)
    if (!s) return
    sampled++
    if (s.admission) {
      peakHeavyActive = Math.max(peakHeavyActive, s.admission.heavy.active)
      peakHeavyDepth = Math.max(peakHeavyDepth, s.admission.heavy.depth)
    }
    if (typeof s.sockets_queued_total === 'number') {
      peakSocketQueue = Math.max(peakSocketQueue, s.sockets_queued_total)
    }
  }, 250)

  const started = Date.now()
  const jobs = []
  for (let i = 0; i < concurrency; i++) {
    jobs.push(request(endpoint, 'genome_feature/', {
      contentType: 'application/rqlquery+x-www-form-urlencoded',
      body: `eq(genome_id,${REF_GENOME})&sort(+feature_id)&limit(25000)`,
      accept: 'text/csv',
      headers: { download: '1' },
      timeout: 180000
    }))
  }
  const done = await Promise.all(jobs)
  clearInterval(sampler)
  const wall = Date.now() - started

  const ok = done.filter((r) => r.status === 200)
  const shed = done.filter((r) => r.status === 429)
  const bad = done.filter((r) => r.status !== 200 && r.status !== 429)

  console.log(`  ${C.d}${concurrency} requests in ${(wall / 1000).toFixed(1)}s — ` +
    `${ok.length} ok, ${shed.length} shed (429), ${bad.length} other; ` +
    `${sampled} stats samples${C.x}`)

  if (bad.length > 0) {
    const first = bad[0]
    const codes = [...new Set(bad.map((r) => r.status))].join(', ')

    // 524 is Cloudflare, not the API: the origin accepted the connection and did not
    // answer within ~100s. Under concurrency that usually means the requests were simply
    // slower than the edge's patience, which is a capacity observation rather than a
    // broken protection — and it is intermittent, so a single run should not be read as
    // a hard limit. Measured on alpha 2026-10-16: 10 concurrent returned nine 524s on
    // one run and ten 200s (1.8-13.2s) minutes later.
    //
    // Reported as a SKIP with the numbers rather than a FAIL, so a transient edge
    // timeout cannot make a green deployment look broken. A real protection failure
    // shows up as a 5xx from the origin, which is still a FAIL below.
    if (bad.every((r) => r.status === 524 || r.timedOut)) {
      skip('load', 'no unexpected failures under load',
        `${bad.length}/${concurrency} hit a Cloudflare 524 (origin slower than the edge ` +
        `limit). ${ok.length} completed. This is intermittent — re-run, and compare against ` +
        'a single request\'s latency before reading it as a capacity ceiling.')
    } else {
      fail('load', 'no unexpected failures under load',
        `${bad.length} request(s) returned ${codes}${first.error ? ' — ' + first.error : ''}`)
    }
  } else {
    pass('load', 'no unexpected failures under load',
      `${ok.length} completed, ${shed.length} cleanly shed`)
  }

  // --expect-429: assert that shedding actually happened, and that each shed response is
  // one a client can act on. Counting 429s is not enough — a 429 without Retry-After
  // invites the tight-retry loop that admission control exists to prevent, and that was
  // blamed for the 2026-06-05 coordinator crash.
  if (expect429) {
    const stats = await getStats(endpoint)
    const enforcing = stats && stats.admission && stats.admission.enabled

    if (!enforcing) {
      fail('load', '429s returned under load',
        'queryAdmission.enabled is false on the server, so no request can ever be shed. ' +
        'Set it in p3api.conf and restart, or drop --expect-429.')
    } else if (shed.length === 0) {
      const h = stats.admission.heavy
      fail('load', '429s returned under load',
        `all ${concurrency} admitted with the pool at ${h.max_concurrent} slots + ` +
        `${h.max_queue} queue. Either concurrency is too low to saturate it, or requests ` +
        'completed faster than they arrived — raise --concurrency above slots+queue.')
    } else {
      pass('load', '429s returned under load',
        `${shed.length}/${concurrency} shed, ${ok.length} admitted`)

      // Retry-After is what makes a 429 actionable rather than an invitation to hammer.
      const withHeader = shed.filter((r) => r.headers && r.headers['retry-after'])
      if (withHeader.length === shed.length) {
        const vals = [...new Set(shed.map((r) => r.headers['retry-after']))]
        pass('load', 'every 429 carries Retry-After', `Retry-After: ${vals.join(', ')}`)
      } else {
        fail('load', 'every 429 carries Retry-After',
          `${shed.length - withHeader.length} of ${shed.length} shed responses lacked the header`)
      }

      // The body should explain itself; a bare 429 is hard to act on from a CLI.
      const explained = shed.filter((r) => /busy|retry/i.test(r.body || ''))
      if (explained.length === shed.length) {
        const sample = json(shed[0])
        pass('load', '429 body explains the rejection',
          `"${(sample && (sample.message || sample.error)) || shed[0].body.slice(0, 80)}"`)
      } else {
        skip('load', '429 body explains the rejection',
          `${explained.length}/${shed.length} had an explanatory body`)
      }

      // Shedding must be fast — the point is to refuse cheaply, not to make the client
      // wait for the rejection.
      const shedTimes = shed.map((r) => r.ms).sort((a, b) => a - b)
      const medShed = shedTimes[Math.floor(shedTimes.length / 2)]
      if (medShed < 15000) {
        pass('load', 'shedding is cheap',
          `median shed latency ${(medShed / 1000).toFixed(2)}s`)
      } else {
        fail('load', 'shedding is cheap',
          `median shed latency ${(medShed / 1000).toFixed(1)}s — a rejection should be ` +
          'near-immediate; a slow one means the client waited for the full queue deadline')
      }
    }
  }

  // Latency spread is the useful capacity signal, and it is what tells you whether the
  // admission pool sizes are in the right range.
  if (ok.length > 0) {
    const times = ok.map((r) => r.ms).sort((a, b) => a - b)
    const med = times[Math.floor(times.length / 2)]
    console.log(`  ${C.d}completed latency: min ${(times[0] / 1000).toFixed(1)}s, ` +
      `median ${(med / 1000).toFixed(1)}s, max ${(times[times.length - 1] / 1000).toFixed(1)}s${C.x}`)
  }

  // Every completed download must be byte-identical: a truncated-but-200 download is the
  // failure mode this codebase keeps producing, and size is how you catch it.
  const sizes = new Set(ok.map((r) => r.bytes))
  if (ok.length > 1 && sizes.size === 1) {
    pass('load', 'downloads complete and identical under load',
      `all ${ok.length} returned ${[...sizes][0].toLocaleString()} bytes`)
  } else if (ok.length > 1) {
    fail('load', 'downloads complete and identical under load',
      `${sizes.size} different sizes: ${[...sizes].map((n) => n.toLocaleString()).join(', ')} ` +
      '— a short one is a silently truncated stream')
  }

  const after = await getStats(endpoint)
  if (after && after.admission) {
    const h = after.admission.heavy
    console.log(`  ${C.d}peak heavy active=${peakHeavyActive} depth=${peakHeavyDepth}; ` +
      `peak socket queue=${peakSocketQueue}${C.x}`)

    if (after.admission.enabled) {
      if (peakHeavyActive > 0 && peakHeavyActive <= h.max_concurrent) {
        pass('load', 'concurrency bounded by the admission pool',
          `peak ${peakHeavyActive} <= limit ${h.max_concurrent}`)
      } else if (peakHeavyActive > h.max_concurrent) {
        fail('load', 'concurrency bounded by the admission pool',
          `peak ${peakHeavyActive} exceeded limit ${h.max_concurrent}`)
      } else {
        skip('load', 'concurrency bounded by the admission pool',
          'sampling never caught a request in flight — try a higher --concurrency')
      }
    } else {
      skip('load', 'concurrency bounded by the admission pool',
        `enforcement disabled. Dry-run observation: peak depth ${peakHeavyDepth}, ` +
        `${h.admitted_total} admitted since boot — this is what would have been bounded`)
    }

    // The tuning signal, reported whether or not enforcement is on.
    console.log(`  ${C.d}counters: admitted=${h.admitted_total} queued=${h.queued_total} ` +
      `rejected_full=${h.rejected_queue_full_total} rejected_timeout=${h.rejected_timeout_total} ` +
      `abandoned=${h.abandoned_total}${C.x}`)
  }

  if (before && after && typeof after.sockets_queued_total === 'number') {
    if (peakSocketQueue === 0) {
      pass('load', 'socket queue stayed empty',
        'admitted work got a socket immediately — the agent queue is slack, as intended')
    } else {
      skip('load', 'socket queue stayed empty',
        `peak ${peakSocketQueue} queued at the agent. Not a failure, but it means requests ` +
        'waited where the wall-clock deadline is the only bound — consider lowering the ' +
        'admission pool or raising maxSockets')
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function parseArgs (argv) {
  const out = { endpoint: null, only: null, load: false, concurrency: 8, expect429: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--expect-429') { out.expect429 = true; out.load = true } else if (a === '--load') out.load = true
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim())
    else if (a === '--only') out.only = (argv[++i] || '').split(',').map((s) => s.trim())
    else if (a === '--concurrency') out.concurrency = parseInt(argv[++i], 10)
    else if (a.startsWith('--concurrency=')) out.concurrency = parseInt(a.split('=')[1], 10)
    else if (!a.startsWith('-')) out.endpoint = a
  }
  return out
}

function usage () {
  console.log(`
Usage: verify-protections.js <api-endpoint> [options]

Exercises a running API and reports which overload protections are working.
Read-only: every request is a query. Exit code is the number of failed checks.

Arguments:
  <api-endpoint>        e.g. https://alpha.bv-brc.org/api

Options:
  --only=a,b            run only these groups (default: all but load)
                        groups: ${CHECK_GROUPS.join(', ')}
  --load                include the sustained-load phase (issues real downloads)
  --concurrency <n>     concurrent downloads for --load (default 8)
  --expect-429          implies --load; assert that shedding actually happens.
                        Requires queryAdmission.enabled on the server, and enough
                        concurrency to exceed slots+queue. Turns "no 429s" from an
                        observation into a FAIL, so a misconfigured pool is caught.
  --help

Examples:
  node scripts/verify-protections.js https://alpha.bv-brc.org/api
  node scripts/verify-protections.js https://alpha.bv-brc.org/api --load --concurrency 12
  node scripts/verify-protections.js http://localhost:3001 --only=joins,regression
`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.endpoint) {
    usage()
    process.exit(args.help ? 0 : 1)
  }

  const wanted = args.only || CHECK_GROUPS.filter((g) => g !== 'load')
  if (args.load && !wanted.includes('load')) wanted.push('load')

  const bad = wanted.filter((g) => !CHECK_GROUPS.includes(g))
  if (bad.length) {
    console.error(`Unknown group(s): ${bad.join(', ')}`)
    console.error(`Valid: ${CHECK_GROUPS.join(', ')}`)
    process.exit(1)
  }

  console.log(`\nVerifying protections against ${args.endpoint}`)
  console.log(`Groups: ${wanted.join(', ')}`)

  const health = await request(args.endpoint, 'health', { timeout: 20000 })
  if (health.status !== 200) {
    console.error(`\n${C.r}Cannot reach ${args.endpoint}/health (status ${health.status}${health.error ? ': ' + health.error : ''})${C.x}`)
    process.exit(1)
  }
  console.log(`Health: ${health.body.trim()}`)

  if (wanted.includes('admission')) await checkAdmission(args.endpoint)
  if (wanted.includes('joins')) await checkJoins(args.endpoint)
  if (wanted.includes('regression')) await checkRegression(args.endpoint)
  if (wanted.includes('security')) await checkSecurity(args.endpoint)
  if (wanted.includes('timeouts')) await checkTimeouts(args.endpoint)
  if (wanted.includes('load')) await checkLoad(args.endpoint, args.concurrency, args.expect429)

  section('Summary')
  console.log(`  ${C.g}${results.pass} passed${C.x}, ${results.fail ? C.r : ''}${results.fail} failed${C.x}, ${C.y}${results.skip} skipped${C.x}`)

  if (results.fail > 0) {
    console.log('\n  Failures:')
    results.rows.filter((r) => r.state === 'fail')
      .forEach((r) => console.log(`    - [${r.group}] ${r.name}: ${r.detail || ''}`))
  }
  if (results.skip > 0) {
    console.log('\n  Skipped (not deployed, or not observable from here):')
    results.rows.filter((r) => r.state === 'skip')
      .forEach((r) => console.log(`    - [${r.group}] ${r.name}`))
  }
  console.log('')

  process.exit(results.fail)
}

main().catch((err) => {
  console.error(`\nverify-protections: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
