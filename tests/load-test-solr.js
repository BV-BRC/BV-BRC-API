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
 */

const fs = require('fs'),
      opts = require('commander'),
      rp = require('request-promise'),
      fetchGenomes = require('./generate-local-data-files').fetchGenomes,
      loadData = require('./index-local-data-files')



if (require.main === module) {
    opts.option('-e, --endpoint [value]', 'Endpoint (Solr url) to index data at')
        .option('-g, --genome-ids [value]',
            'JSON file with list of genome ids or comma-separated list')
        .option('-f, --files-dir [value]',
            `Where to store and load files from`)
        .option('-o, --owner [value]', 'Change owner of objects to this owner')
        .option('-p, --set-private', 'Set genomes as "public: false"')
        .parse(process.argv)


    if(!opts.genomeIds) {
        console.error(`Must provide genome IDs or use --bulk option.  --help for more`);
        opts.outputHelp();
        return 1;
    }

    if(!opts.endpoint) {
        console.error(`Must provide endpoint "-e" where data will be indexed`);
        opts.outputHelp();
        return 1;
    }

    if(!opts.filesDir) {
        console.error(`Must provide path "-f" for where to store and load files from `);
        opts.outputHelp();
        return 1;
    }

    fetchAndLoad(opts.genomeIds, opts.filesDir);
}


async function fetchAndLoad(genomeIDs, fileDir) {
    console.log(`*** Fetching genomes to ${fileDir}...`)
    await fetchGenomes({genomeIDs, outputDir: fileDir});

    console.log(`*** Loading ${fileDir} into Solr...`)
    await loadData(fileDir);
}