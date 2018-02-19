#!/usr/bin/env node
/**
 *  generate_local_data_files.json
 *
 *  Fetech
 *
 *  Example Usages:
 *  - fetch 20 genomes (and associated cores for each)
 *      ./generate_local_data_files.js --bulk=20
 *
 *  - fetch some private genomes
 *      ./generate_local_data_files.js
 *          --genome_ids=99999.98,99999.99
 *          --token="<your_token>"
 *
 */

const fs = require('fs'),
      path = require('path'),
      process = require('process'),
      opts = require('commander'),
      request = require('request'),
      rp = require('request-promise');

const DATA_API_URL = 'https://p3.theseed.org/services/data_api'

// max number of docs that can be fetched.  Script will end if exceeded.
const DOC_LIMIT = 500000;

// cores that will be fetched for each genome
const KEY_CORES = ['genome', 'genome_feature', 'genome_sequence', 'pathway', 'sp_gene', 'genome_amr'];

// defaults
const DEFAULT_ID_STR = '1763.134,83332.349,205918.41,83332.228';
let outDir = './data-files';

const getOpts = {
    json: true,
    headers: {
      "content-type": "application/json",
      "authorization": opts.token || ''
    }
  }

let totalGenomes; // for progress

if (require.main === module){
    opts.option('-g, --genome_ids [value]', 'Genome IDs comma delimited')
        .option('-b, --bulk <n>', 'Number of "random" genomes to grab. ' +
                'NOTE: this will ignore the --genome_ids option.')
        .option('-f, --force [value]', 'Force to update cached data')
        .option('-d, --data_api [value]', 'Use specific Data API endpoint')
        .option('-o, --output [value]', 'Out put directory (./data-files/ is default')
        .option('-s, --skip_existing', "Skip existing genome directories")
        .option('--token [value]', 'Token, if Data API is being used')
        .parse(process.argv)


    if (!opts.genome_ids && !opts.bulk) {
        console.error(`Warning: no genome_ids given. Using default: ${DEFAULT_ID_STR}'\n`);
    }

    let genomeIDs = (opts.genome_ids || DEFAULT_ID_STR).split(',');
    outDir = opts.output || outDir

    let existingDirs;
    if (opts.skip_existing) {
        existingDirs = fs.readdirSync(outDir).filter(f =>
            fs.statSync(path.join(outDir, f)).isDirectory()
        )
    }

    // if bulk option is given, first get some genomeIDs
    // then recursively fetch data
    if (opts.bulk) {
        const query = `?limit(${opts.bulk})&select(genome_id)&keyword(*)`;
        const url = `${opts.endpoint || DATA_API_URL}/genome/${query}`;
        rp.get(url, getOpts).then(body => {

            genomeIDs = body.map(o => o.genome_id );

            if (opts.skip_existing) {
                let cntBefore = genomeIDs.length
                genomeIDs = genomeIDs.filter(id => !existingDirs.includes(id))
                console.log(`\nSkiping ${cntBefore - genomeIDs.length} genomes\n`)
            }

            totalGenomes = genomeIDs.length;

            recursiveFetch(genomeIDs);
        }).catch((e) => {
            console.log(e);
        })

        return;
    }

    // if genome_ids is provided as an option
    totalGenomes = genomeIDs.length;
    recursiveFetch(genomeIDs);
}


/**
 * recursively fetch associated genome core data, one genome at a time
 * note: for each genome, requests for core data is in parallel
 * @param {*} genomeIDs list of genome ids
 *
 */
function recursiveFetch(genomeIDs) {
    console.log(`Percent Complete: ${(1 - genomeIDs.length / totalGenomes).toFixed(2) * 100}%\n`);

    // fetch all data for first genome, then continue through list
    fetchAllFromAPI([genomeIDs[0]]).then((res) => {
        genomeIDs.shift();
        if (genomeIDs.length)
            recursiveFetch(genomeIDs);
    })
}


/**
 * fetches all data for a genomeID in parallel
 * @param {*} genomeID genome id of interest
 */
function fetchAllFromAPI(genomeID) {
    const reqs = KEY_CORES.map(core => apiRequest(core, genomeID));
    return Promise.all(reqs).then(body => {

        const dirname = `${outDir}/${genomeID}`;
        createFolderSync(dirname);

        KEY_CORES.forEach((core, i) => {
            writeFileSync(body[i], `${dirname}/${core}.json`);
        })
    })
}

/**
 * requests data for a genome from Solr, given core and genome id
 * @param {*} core core to fetch from
 * @param {*} genome_id match on gneome ids
 */
function apiRequest(core, genome_id) {
    const query = `?limit(${DOC_LIMIT})&eq(genome_id,${genome_id})`+
        `&http_accept=application/solr+json&http_download=true`;
    const url = `${opts.endpoint || DATA_API_URL}/${core}/${query}`;

    console.log(`Requesting ${genome_id} from core ${core}...`)
    return rp.get(url, getOpts).then(body => {
        let numFound = body.response.numFound;
        let docs = body.response.docs;

        console.log(`Number of docs found for ${core}: ${numFound}`);

        if (numFound > docs.length) {
            console.error(`The number of results found (${numFound}) exceeds the limit you have set.  Ending.`);
            process.exit();
        }

        return docs;
    }).catch((e) => {
        console.log(e);
    })
}

function createFolderSync(dirname){
    // create base directory first
    let base = dirname.slice(0, dirname.lastIndexOf('/'));
    if (!fs.existsSync(base)) {
        fs.mkdirSync(base);
    }

    // create genome directory
    if (!fs.existsSync(dirname) && opts.force == true){
        fs.rmdirSync(dirname);
    }

    if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname);
    }
}

function writeFileSync(json, filePath) {
    fs.writeFileSync(filePath, JSON.stringify(json, null, 4), 'utf8');
    console.log('Wrote:', filePath);
}