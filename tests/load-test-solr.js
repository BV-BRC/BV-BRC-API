#!/usr/bin/env node
/**
 *  load-test-solr.js
 *
 *  Fetches and loads specific genome ids into local solr.
 *  The list of genomes to fetch/load is in test-genome-ids.json
 *
 *  Uses "fileDir" default directory (below) to save JSON.
 *
 *  Example Usage:
 *      ./load-test-solr.js
 *             -e http://localhost:8983/!local!/solr/
 *             -g
 *             -o user@patricbrc.org  (set owner of objects, useful for API testing)
 *             -f ./test-files
 *
 *  Permission fixtures (see Docs/LOCAL_SOLR_SETUP.md):
 *
 *    # public set
 *    ./load-test-solr.js -e http://localhost:8983/solr \
 *        -g ./5-test-genome-ids.json -f ./test-files-public
 *
 *    # private to alice, readable by bob — exercises all three branches of the
 *    # permission fq (public / owner / user_read)
 *    ./load-test-solr.js -e http://localhost:8983/solr \
 *        -g ./50-test-genome-ids-2.json -f ./test-files-private \
 *        -o alice@patricbrc.org -p -r bob@patricbrc.org
 *
 *    # only the cores you have collections for
 *    ./load-test-solr.js ... -c genome,genome_feature,sp_gene
 *
 *  Fetching (phase 1) needs internet but no Solr and no VPN; indexing (phase 2)
 *  needs the collections to already exist in the target Solr.
 */

const opts = require('commander')
const fetchGenomes = require('./generate-local-data-files').fetchGenomes
const loadData = require('./index-local-data-files')

if (require.main === module) {
  opts.option('-e, --endpoint [value]', 'Endpoint (Solr url) to index data at')
    .option('-g, --genome-ids [value]',
      'JSON file with list of genome ids or comma-separated list')
    .option('-f, --files-dir [value]',
      `Where to store and load files from`)
    .option('-o, --owner [value]', 'Change owner of objects to this owner')
    .option('-p, --set-private', 'Set genomes as "public: false"')
    .option('-r, --user-read [value]',
      'Comma-separated users to put in user_read (permission-sharing fixtures)')
    .option('-c, --cores [value]',
      'Comma-separated cores to load; defaults to every core in the fixture dir')
    .parse(process.argv)

  if (!opts.genomeIds) {
    console.error(`Must provide genome IDs or use --bulk option.  --help for more`)
    opts.outputHelp()
    process.exit()
  }

  if (!opts.endpoint) {
    console.error(`Must provide endpoint "-e" where data will be indexed`)
    opts.outputHelp()
    process.exit()
  }

  if (!opts.filesDir) {
    console.error(`Must provide path "-f" for where to store and load files from `)
    opts.outputHelp()
    process.exit()
  }

  fetchAndLoad(opts.genomeIds, opts.filesDir)
}

async function fetchAndLoad (genomeIDs, fileDir) {
  console.log(`*** Fetching genomes to ${fileDir}...`)
  await fetchGenomes({ genomeIDs, outputDir: fileDir })

  console.log(`*** Loading ${fileDir} into Solr...`)
  await loadData(fileDir)
}
