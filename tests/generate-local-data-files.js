#!/usr/bin/env node
/**
 *  generate_local_data_files.json
 *
 *  Fetches genome data from Data API saves as directory of JSON files
 *
 *  Example Usages:
 *  - fetch 20 genomes (and associated cores for each) and write to specific dir
 *      ./generate-local-data-files.js --bulk=20 --output="./data-files"
 *
 *  - fetch some private genomes
 *      ./generate-local-data-files.js
 *          --genome-ids=99999.98,99999.99
 *          --token="<token>"
 *
 */

const fs = require('fs')
const path = require('path')
const process = require('process')
const opts = require('commander')
const rp = require('request-promise')

const DATA_API_URL = 'https://p3.theseed.org/services/data_api'

// max number of docs that can be fetched.  Script will end if exceeded.
const DOC_LIMIT = 500000

// cores that will be fetched for each genome
const GENOME_CORES = [
  'genome', 'genome_feature', 'genome_sequence',
  'pathway', 'sp_gene', 'genome_amr', 'subsystem'
]

// defaults
const DEFAULT_IDS = require('./5-test-genome-ids.json')
const OUT_DIR = './test-files'

let getOpts = {
  json: true,
  headers: {
    'content-type': 'application/json'
  }
}

if (require.main === module) {
  opts.option('-g, --genome-ids [value]', 'Genome IDs comma delimited')
    .option('-b, --bulk <n>', 'Number of "random" genomes to grab. ' +
            'NOTE: this will ignore the --genome-ids option.')
    .option('-f, --force [value]', 'Force to update cached data')
    .option('-o, --output [value]',
      `Output directory; defaults to ${OUT_DIR}`)
    .option('-s, --skip-existing', 'Skip existing genome directories')
    .option('--token [value]', 'Token, if Data API is being used')
    .parse(process.argv)

  getOpts.headers.authorization = opts.token || ''

  if (!opts.genomeIds && !opts.bulk) {
    console.error(`Must provide genome IDs or use --bulk option.  --help for more`)
    opts.help()
  }

  let genomeIDs = opts.genomeIds ? opts.genomeIds.split(',') : DEFAULT_IDS
  outDir = opts.output || OUT_DIR

  let existingDirs
  if (opts.skipExisting) {
    existingDirs = fs.readdirSync(outDir).filter(f =>
      fs.statSync(path.join(outDir, f)).isDirectory()
    )
  }

  // if bulk option is given, first get some genomeIDs
  // then recursively fetch data
  if (opts.bulk) {
    const query = `?limit(${opts.bulk})&select(genome_id)&keyword(*)`
    const url = `${DATA_API_URL}/genome/${query}`
    rp.get(url, getOpts).then(body => {
      genomeIDs = body.map(o => o.genome_id)

      if (opts.skipExisting) {
        let cntBefore = genomeIDs.length
        genomeIDs = genomeIDs.filter(id => !existingDirs.includes(id))
        console.log(`\nSkiping ${cntBefore - genomeIDs.length} genomes\n`)
      }

      totalGenomes = genomeIDs.length

      recursiveFetch(genomeIDs)
    }).catch((e) => {
      console.log(e)
    })

    exit()
  }

  // if genome_ids is provided as an option
  fetchGenomes({genomeIDs, outputDir: outDir})
}

/**
 * recursively fetch associated genome core data, one genome at a time
 * note: for each genome, requests for core data is in parallel
 *
 * @param {Object} params - param object
 * @param {string} params.genomeIDs - list of genome ids
 * @param {string} params.outputDir - path to where genomes will be saved
 */
async function fetchGenomes (params) {
  let {genomeIDs, outputDir} = params

  // if string, assume file path
  if (!Array.isArray(genomeIDs)) { genomeIDs = require(genomeIDs) }

  // get cores for each genome in parallel
  for (const [i, id] of genomeIDs.entries()) {
    await fetchAllCores(id, outputDir)
    let percent = ((i + 1) / genomeIDs.length).toFixed(2) * 100
    console.log(`Percent Complete: ${percent}%\n`)
  }

  console.log(`Wrote files to: ${outputDir}`)
}

/**
 * fetches all data for a single genomeID in parallel,
 * and writes to <dirname>/<core>.json
 *
 * @param {string} genomeID - genome id of interest
 * @param {string} outputDir - path to where genomes will be saved
 */
async function fetchAllCores (genomeID, outputDir) {
  const reqs = GENOME_CORES.map(core => apiRequest(core, genomeID))
  return Promise.all(reqs).then(contents => {
    const dirname = `${outputDir}/${genomeID}`
    createFolderSync(dirname)

    GENOME_CORES.forEach((core, i) => {
      writeFileSync(contents[i], `${dirname}/${core}.json`)
    })
  })
}

/**
 * requests data for a genome from Solr, given core and genome id
 *
 * @param {string} core - core to fetch from
 * @param {string} genome_id - match on gneome ids
 */
function apiRequest (core, genomeID) {
  const query = `?limit(${DOC_LIMIT})&eq(genome_id,${genomeID})` +
        `&http_accept=application/solr+json&http_download=true`

  const url = `${DATA_API_URL}/${core}/${query}`

  console.log(`Requesting ${genomeID} from core ${core}...`)
  return rp.get(url, getOpts).then(body => {
    let numFound = body.response.numFound
    let docs = body.response.docs

    console.log(`Number of docs found for ${core}: ${numFound}`)

    if (numFound > docs.length) {
      console.error(`The number of results found (${numFound}) exceeds the limit you have set.  Ending.`)
      process.exit()
    }

    return docs
  }).catch((e) => {
    console.log(e.message)
  })
}

function createFolderSync (dirname) {
  // create base directory first
  let base = dirname.slice(0, dirname.lastIndexOf('/'))
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base)
  }

  // create genome directory
  if (!fs.existsSync(dirname) && opts.force === true) {
    fs.rmdirSync(dirname)
  }

  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname)
  }
}

function writeFileSync (json, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(json, null, 4), 'utf8')
  console.log('Wrote:', filePath)
}

module.exports = {
  fetchGenomes: fetchGenomes
}
