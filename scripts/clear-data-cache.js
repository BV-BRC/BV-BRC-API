#!/usr/bin/env node
/**
 * clear-data-cache.js — drop the cached /data/* responses from Redis.
 *
 * Use after anything that changes what /data returns without changing its URLs:
 * a hiddenPublicTaxa or publicOwners change, a data load, a permission fix. Run it
 * AFTER `pm2 reload`, or workers still running the old code re-cache the old answers.
 *
 *   node scripts/clear-data-cache.js                 # dry run: show what would go
 *   node scripts/clear-data-cache.js --yes           # delete
 *   node scripts/clear-data-cache.js --warm --yes    # refresh warmed taxa, then delete the rest
 *   node scripts/clear-data-cache.js --warm=top6 --yes
 *   node scripts/clear-data-cache.js --endpoint distinct --yes
 *
 * Options:
 *   --yes            actually delete (default is a dry run)
 *   --warm[=top6]    first run scripts/warm-taxon-summaries.sh [--top6], which overwrites
 *                    the warmed summary_by_taxon keys in place
 *   --endpoint NAME  only this /data endpoint (repeatable): summary_by_taxon, distinct,
 *                    taxon_category, subsystem_summary
 *   --all            also delete the warmed summary_by_taxon keys (see below)
 *
 * WHY THE WARMED KEYS ARE KEPT BY DEFAULT
 *
 * The broad taxa that scripts/warm-taxon-summaries.sh maintains cannot be refilled by an
 * ordinary request: Viruses takes ~23 minutes, far past Cloudflare's ~125 s budget, so a
 * deleted key stays empty and every visitor starts its own recomputation (apicache does
 * no request coalescing). Those keys are instead overwritten in place by the warmer —
 * pass --warm to do that now, or leave them for the nightly cron (01:30), which refreshes
 * them within a day. The list is read from the warmer's ALL_TAXA, so the two cannot drift.
 *
 * Redis settings come from p3api.conf (or $P3_API_CONFIG) via the same option handling
 * /admin uses, so the password spelling quirks there apply here too.
 */

const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const REPO = path.resolve(__dirname, '..')
// config.js resolves './p3api.conf' against the CWD, as the API does.
process.chdir(REPO)

const ENDPOINTS = ['summary_by_taxon', 'distinct', 'taxon_category', 'subsystem_summary']
const WARMER = path.join(REPO, 'scripts', 'warm-taxon-summaries.sh')

function parseArgs (argv) {
  const opts = { yes: false, all: false, warm: null, endpoints: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes') opts.yes = true
    else if (a === '--all') opts.all = true
    else if (a === '--warm') opts.warm = 'all'
    else if (a === '--warm=top6') opts.warm = 'top6'
    else if (a === '--endpoint') opts.endpoints.push(argv[++i])
    else if (a.startsWith('--endpoint=')) opts.endpoints.push(a.slice('--endpoint='.length))
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).map((l) => l.replace(/^ \* ?/, '')).join('\n'))
      process.exit(0)
    } else {
      console.error(`unknown option: ${a}  (try --help)`)
      process.exit(2)
    }
  }
  for (const e of opts.endpoints) {
    if (!ENDPOINTS.includes(e)) {
      console.error(`unknown endpoint: ${e}  (one of ${ENDPOINTS.join(', ')})`)
      process.exit(2)
    }
  }
  return opts
}

/** Taxon ids from the warmer's ALL_TAXA array. Throws rather than guess. */
function warmedTaxa () {
  const src = fs.readFileSync(WARMER, 'utf8')
  const m = src.match(/^ALL_TAXA=\(\n([\s\S]*?)^\)/m)
  if (!m) throw new Error(`could not find ALL_TAXA in ${WARMER}`)
  const ids = m[1].split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
  if (!ids.length || !ids.every((t) => /^\d+$/.test(t))) {
    throw new Error(`unexpected ALL_TAXA contents in ${WARMER}: ${JSON.stringify(ids)}`)
  }
  return ids
}

function endpointOf (key) {
  // keys are req.originalUrl verbatim: /data/<endpoint>/...[?query]
  return key.split('?')[0].split('/')[2] || '(none)'
}

function scanAll (client, pattern) {
  return new Promise((resolve, reject) => {
    const keys = []
    const step = (cursor) => {
      client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000, (err, res) => {
        if (err) return reject(err)
        keys.push(...res[1])
        if (res[0] === '0') resolve(keys)
        else step(res[0])
      })
    }
    step('0')
  })
}

function del (client, keys) {
  return new Promise((resolve, reject) => client.del(keys, (err, n) => err ? reject(err) : resolve(n)))
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))

  // Required after chdir so config.js finds p3api.conf. nconf also parses argv, which
  // only adds harmless keys for these flags.
  const redis = require('redis')
  const { redisOptions } = require('../routes/adminRouter')
  const ropts = redisOptions()

  const keepSet = new Set()
  if (!opts.all) {
    for (const t of warmedTaxa()) keepSet.add(`/data/summary_by_taxon/${t}`)
  }

  if (opts.warm) {
    if (!opts.yes) {
      console.log(`(dry run: would first run ${path.relative(REPO, WARMER)}${opts.warm === 'top6' ? ' --top6' : ''})`)
    } else {
      console.log(`### running ${path.relative(REPO, WARMER)}${opts.warm === 'top6' ? ' --top6' : ''}`)
      const r = spawnSync('bash', [WARMER, ...(opts.warm === 'top6' ? ['--top6'] : [])], { stdio: 'inherit' })
      if (r.status !== 0) {
        console.log(`### warmer reported ${r.status} failure(s); continuing with the clear`)
      }
    }
  }

  const client = redis.createClient(ropts)
  let failed = false
  client.on('error', (err) => {
    if (!failed) console.error(`redis error: ${err.message}`)
    failed = true
    process.exitCode = 1
    client.end(false)
  })

  try {
    console.log(`### redis ${ropts.host || '127.0.0.1'}:${ropts.port || 6379} db ${ropts.db || 0}`)
    const keys = await scanAll(client, '/data/*')
    const stats = {}
    const doomed = []
    for (const k of keys) {
      const ep = endpointOf(k)
      const s = stats[ep] || (stats[ep] = { total: 0, delete: 0, keep: 0 })
      s.total++
      const selected = !opts.endpoints.length || opts.endpoints.includes(ep)
      if (selected && !keepSet.has(k)) {
        s.delete++
        doomed.push(k)
      } else {
        s.keep++
      }
    }

    console.log(`${'endpoint'.padEnd(20)} ${'cached'.padStart(8)} ${(opts.yes ? 'deleted' : 'would del').padStart(10)} ${'kept'.padStart(6)}`)
    for (const [ep, s] of Object.entries(stats).sort()) {
      console.log(`${ep.padEnd(20)} ${String(s.total).padStart(8)} ${String(s.delete).padStart(10)} ${String(s.keep).padStart(6)}`)
    }
    const keptWarm = keys.filter((k) => keepSet.has(k))
    if (keptWarm.length) {
      console.log(`kept ${keptWarm.length} warmed summary_by_taxon key(s): ${keptWarm.map((k) => k.split('/').pop()).join(' ')}`)
      if (!opts.warm) console.log('  these still hold the old counts until the warmer runs (--warm, or the nightly cron)')
    }

    if (!opts.yes) {
      console.log(`dry run: ${doomed.length} key(s) would be deleted. Re-run with --yes.`)
    } else {
      let n = 0
      for (let i = 0; i < doomed.length; i += 500) n += await del(client, doomed.slice(i, i + 500))
      console.log(`deleted ${n} key(s)`)
    }
  } finally {
    if (!failed) client.quit()
  }
}

main().catch((err) => {
  console.error(`### ERROR: ${err.message}`)
  process.exit(1)
})
