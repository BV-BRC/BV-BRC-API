#!/usr/bin/env node
/**
 *
 * Example Usage(s):
 *   - load directory ./test-files into Solr
 *      ./index-local-data-files.js
 *          -i ./test-files/                          (optional; default: ./data-files)
 *          -e http://localhost:8983/some/solr
 *          -o user@patricbrc.org                     (optional; change owner of all records)
 *          -r bob@patricbrc.org,carol@patricbrc.org  (optional; grant read access)
 *          -c genome,genome_feature,sp_gene          (optional; only load these cores)
 *
 *  The fixture directory holds one file per core (genome.json, sp_gene.json, …);
 *  each is POSTed to the collection matching its filename. Collections that do
 *  not exist in the target Solr are reported and skipped — see
 *  Docs/LOCAL_SOLR_SETUP.md for creating them from the bv-brc-solr configsets.
 */

const fs = require('fs')
const opts = require('commander')
const rp = require('request-promise')
const util = require('util')

const readFile = util.promisify(fs.readFile)
const readDir = util.promisify(fs.readdir)

const BASE_DATA_DIR = './test-files'

if (require.main === module) {
  opts.option('-t, --token [value]', 'Token for private genome access')
    .option('-e, --endpoint [value]', 'Endpoint to index data at')
    .option('-i, --input [value]',
      `Directory to index into Solr; defaults to ${BASE_DATA_DIR}`)
    .option('-o, --owner [value]', 'Set new owner for data being indexed')
    .option('-p, --set-private', 'Set genomes as "public: false"')
    .option('-r, --user-read [value]',
      'Comma-separated users to put in user_read (permission-sharing fixtures)')
    .option('-c, --cores [value]',
      'Comma-separated cores to load; defaults to every file in the fixture dir')
    .parse(process.argv)

  if (!opts.endpoint) {
    console.error(`Must provide endpoint "-e" where data will be indexed`)
    process.exit()
  }

  loadData(opts.input)
}

async function loadData (inputDir) {
  const baseDir = inputDir || BASE_DATA_DIR
  const genomes = await readDir(baseDir)

  const onlyCores = opts.cores
    ? opts.cores.split(',').map(c => c.trim()).filter(Boolean)
    : null

  let genomeCount = genomes.length
  const skipped = new Set()
  const failed = new Set()
  const loaded = new Set()

  for (const [i, genome] of genomes.entries()) {
    console.log(`Indexing genome ${genome}...`)
    var files = await readDir(`${baseDir}/${genome}`)

    for (const entry of files.entries()) {
      let file = entry[1]
      let core = file.split('.')[0]
      let f = `${baseDir}/${genome}/${file}`

      if (onlyCores && onlyCores.indexOf(core) < 0) {
        skipped.add(core)
        continue
      }

      const result = await submit(core, f)
      if (result === MISSING_COLLECTION) {
        failed.add(core)
      } else if (result !== SUBMIT_FAILED) {
        loaded.add(core)
      } else {
        failed.add(core)
      }
    }

    console.log(`Progress: ${((i + 1) / genomeCount * 100).toFixed(2)}% \n`)
  }

  // Summarize. Previously every failure was a lone console.error in a loop of
  // hundreds of lines — a missing collection (Solr answers 404 with an HTML
  // "Searching for Solr?" page) looked indistinguishable from success at the end
  // of a run. Callers need to know which cores actually landed.
  console.log('\n=== Load summary ===')
  console.log(`  loaded:  ${Array.from(loaded).sort().join(', ') || '(none)'}`)
  if (skipped.size) {
    console.log(`  skipped: ${Array.from(skipped).sort().join(', ')} (not in --cores)`)
  }
  if (failed.size) {
    console.log(`  FAILED:  ${Array.from(failed).sort().join(', ')}`)
    console.log('\n  A failed core usually means the collection does not exist in the')
    console.log('  target Solr. Create it from the bv-brc-solr configsets first —')
    console.log('  see Docs/LOCAL_SOLR_SETUP.md. Re-run afterwards; loads are idempotent.')
    process.exitCode = 1
  }
}

const MISSING_COLLECTION = Symbol('missing-collection')
const SUBMIT_FAILED = Symbol('submit-failed')

function submit (core, filePath) {
  const query = 'update?versions=true&commit=true'
  const url = `${opts.endpoint}/${core}/${query}`

  const mods = []
  if (opts.owner) mods.push(`owner=${opts.owner}`)
  if (opts.setPrivate) mods.push('public=false')
  if (opts.userRead) mods.push(`user_read=[${opts.userRead}]`)

  console.log(`Loading core ${core}${mods.length ? ' (' + mods.join(', ') + ')' : ''}`)

  // Comma-separated -> array. user_read is multiValued in the BV-BRC schemas;
  // sending a bare string would index a single value containing commas.
  const readUsers = opts.userRead
    ? opts.userRead.split(',').map(u => u.trim()).filter(Boolean)
    : null

  let warnedMissingOwner = false

  return readFile(filePath, 'utf8').then((data) => {
    let objs = JSON.parse(data)

    if (!objs.length) {
      console.log(`  (empty fixture, nothing to load)`)
      return null
    }

    objs.forEach(o => {
      if (!('owner' in o) && !warnedMissingOwner) {
        // Warn once per file rather than once per document — a 10k-doc feature
        // fixture otherwise buries the rest of the output.
        console.error(`  Warning: no existing owner field in ${filePath}`)
        warnedMissingOwner = true
      }

      // Drop _version_ carried over from the source API. The update URL sets
      // versions=true, which turns _version_ into an optimistic-concurrency
      // precondition: Solr compares it against the (nonexistent) local doc and
      // rejects the whole batch with HTTP 409 "version conflict … actual=-1".
      // Every fixture the downloader produces has this field, so without the
      // delete no fetched data can be indexed at all.
      delete o._version_

      // set owner if needed
      if (opts.owner) o.owner = opts.owner

      // set as private if needed
      if (opts.setPrivate) o.public = false

      // grant read access if needed — the piece the loader could not do before,
      // so permission-sharing fixtures had to be patched into Solr by hand.
      if (readUsers) o.user_read = readUsers
    })

    return rp.post({
      url: url,
      json: objs
    }).then(body => {
      console.log(`  ok: ${objs.length} docs -> ${core}`)
      return body
    }).catch(e => {
      // Solr answers an unknown collection with a 404 whose body is an HTML
      // "Searching for Solr? You must type the correct path." page. Name that
      // case explicitly; it is by far the most common reason a load silently
      // does nothing.
      if (e.statusCode === 404) {
        console.error(`  MISSING COLLECTION '${core}' at ${opts.endpoint} — skipping`)
        return MISSING_COLLECTION
      }
      console.error(`  FAILED ${core}: ${e.message.split('\n')[0]}`)
      return SUBMIT_FAILED
    })
  }).catch(e => {
    console.error(`  FAILED reading ${filePath}: ${e.message}`)
    return SUBMIT_FAILED
  })
}

module.exports = loadData
module.exports.MISSING_COLLECTION = MISSING_COLLECTION
module.exports.SUBMIT_FAILED = SUBMIT_FAILED
