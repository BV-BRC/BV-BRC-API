#!/usr/bin/env node
/**
 *  setup-test-solr.js
 *
 *  Fetches and loads specific genome ids into local solr.
 *  The list of genomes to fetch/load is in test-genome-ids.json
 *
 *  Uses "fileDir" default directory  to save JSON.
 *
 *  Example Usage:
 *      ./setup-test-solr.js -e http://localhost:8983/!local!/solr/
 *
 */

const fs = require('fs'),
      opts = require('commander'),
      rp = require('request-promise'),
      fetchGenomes = require('./generate-local-data-files').fetchGenomes,
      loadData = require('./index-local-data-files')

const genomeIDs = require('./5-test-genome-ids.json');
const fileDir = './test-files'


if (require.main === module) {
    opts.option('-e, --endpoint [value]', 'Endpoint (Solr url) to index data at')
        .option('-o, --owner [value]', 'Change owner of objects to this owner')
        .parse(process.argv)


    if(!opts.endpoint) {
        console.error(`Must provide endpoint "-e" where data will be indexed`);
        opts.outputHelp()
        return 1;
    }

    fetchAndLoad(opts.endpoint)
}



async function fetchAndLoad(endpoint) {
    console.log('fetching genomes...')
    await fetchGenomes({genomeIDs, outputDir: fileDir});

    console.log(`Loading ${fileDir} into solr...`)
    await loadData(fileDir);
}