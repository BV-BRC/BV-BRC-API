#!/usr/bin/env node
/**
 *  generate_local_data_files.json
 *
 *  Fetech
 *
 *  Example Usages:
 *  - fetch 20 genomes (and associated cores for each)
 *      ./generate_local_data_files.js --data_api --bulk=20
 *
 *  - fetch some private genomes
 *      ./generate_local_data_files.js --data_api --genome_ids=99999.98,99999.99
 *          --token="<your_token>"
 *
 */

const fs = require('fs'),
      process = require('process'),
      opts = require('commander'),
      request = require('request'),
      rp = require('request-promise');

const DATA_API_URL = 'https://p3.theseed.org/services/data_api'
const DISTRIBUTE_URL = 'http://chestnut.mcs.anl.gov:8983/solr'

// max number of docs that can fetched.  Script will end if exceed
const DOC_LIMIT = 500000;

// cores that will be fetched for each genome
const KEY_CORES = ['genome', 'genome_feature', 'genome_sequence', 'pathway', 'sp_gene', 'genome_amr'];

// defaults
const BASE_DATA_DIR = './data-files';
const DEFAULT_ID_STR = '1763.134,83332.349,205918.41,83332.228';

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
        .option('-d, --data_api [value]', 'Use given Data API endpoint, instead of SOLR directly.')
        .option('-e, --solr [value]', 'Use SOLR to grab data.  Must provide endpoint ' +
            '(i.e., http://chestnut.mcs.anl.gov:8983/solr).  Can not use with --bulk.')
        .option('-o, --output [value]', 'Out put directory (./data-files/ is default')
        .option('--token [value]', 'Token, if Data API is being used')
        .parse(process.argv)


    if (!opts.genome_ids && !opts.bulk) {
        console.error(`Warning: no genome_ids given. Using default: ${DEFAULT_ID_STR}'\n`);
    }
    let genomeIDs = (opts.genome_ids || DEFAULT_ID_STR).split(',');

    if (!opts.data_api && !opts.solr_url) {
        console.error(`Must specify at least --date_api or --solr\n`);
        return;
    }

    if (opts.bulk && opts.solr) {
        console.error('Sorry, the --bulk option can not be used with the --solr' +
            ' option as of now');
        return;
    }


    // if bulk option is given, first get some genomeIDs
    // then recursively fetch data
    if (opts.bulk) {
        const query = `?limit(${opts.bulk})&select(genome_id)&keyword(*)`;
        const url = `${opts.endpoint || DATA_API_URL}/genome/${query}`;
        rp.get(url, getOpts).then(body => {
                let resStr = JSON.stringify(body, null, 4);

                genomeIDs = body.map(o => o.genome_id);
                totalGenomes = genomeIDs.length;

                recursiveFetch(genomeIDs);
            }).catch((e) => {
                console.log(e);
            })

        return;
    }

    // if genome_ids is provided as an option
    if (opts.data_api) {
        totalGenomes = genomeIDs.length;
        recursiveFetch(genomeIDs);
        return;
    } else if (opts.solr) {
        genomeIDs.forEach(genome_id => {
            const reqs = KEY_CORES.map(core => solrRequest(core, genome_id));
            Promise.all(reqs).then(body => {
                const dirname = `${opts.output || BASE_DATA_DIR}/${genome_id}`;
                createFolderSync(dirname);

                KEY_CORES.forEach((core, i) => {
                    writeFileSync(body[i], `${dirname}/${core}.json`);
                })
            })
        })
    }
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

        const dirname = `${opts.output || BASE_DATA_DIR}/${genomeID}`;
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
function apiRequest(core, genome_id){
    const query = `?limit(${DOC_LIMIT})&eq(genome_id,${genome_id})`+
        `&keyword(*)&http_accept=application/solr+json&http_download=true`;
    const url = `${opts.endpoint || DATA_API_URL}/${core}/${query}`;

    console.log(`requesting ${genome_id} from core ${core}...`)
    return rp.get(url, getOpts).then(body => {
        let numFound = body.response.numFound;
        let docs = body.response.docs;

        console.log(`Number of docs found for ${core}: ${numFound}`);

        if (numFound > docs.length) {
            console.error(`The number of results found (${numFound}) exceeds the limit you have set.  Ending.`);
            process.exit();
        }

        return body;
    }).catch((e) => {
        console.log(e);
    })
}


/**
 * requests data for a genome from Solr, given core and genome id
 * @param {*} core the core of interest
 * @param {*} genome_id the genome id of interest
 */
function solrRequest(core, genome_id){
    const query = `select?q=genome_id:${genome_id}&rows=${DOC_LIMIT}&wt=json`,
          url = `${opts.endpoint || DISTRIBUTE_URL}/${core}/${query}`;

    console.log("requesting: ", url)
    return rp.get({
        url: url,
        json: true
    }).then(body => {
        def.resolve(body.response.docs)
    }).catch(e => {
        console.error(e);
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