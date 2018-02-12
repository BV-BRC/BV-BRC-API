#!/usr/bin/env node
/**
 *
 * Example Usage:
 *  ./generate_local_data_files.js
 *      --solr-endpoint http://chestnut.mcs.anl.gov:8983/solr
 *
 */

const fs = require('fs')
const sys = require('sys')
const process = require('process')
const opts = require('commander')
const request = require('request')
const rp = require('request-promise')
const Deferred = require('promised-io/promise').Deferred
const when = require('promised-io/promise').when
const all = require('promised-io/promise').all

const DATA_API_URL = 'https://p3.theseed.org/services/data_api/genome/'
const DISTRIBUTE_URL = 'http://chestnut.mcs.anl.gov:8983/solr'

const KEY_CORES = ['genome', 'genome_feature', 'genome_sequence', 'pathway', 'sp_gene', 'genome_amr']
const BASE_DATA_DIR = './data_files'
const DEFAULT_ID_STR = '1763.134,83332.349,205918.41,83332.228'


if (require.main === module){
    opts.option('-g, --genome_ids [value]', 'Genome IDs comma delimited')
        .option('-b, --bulk <n>', 'Number of "random" genomes to grab. ' +
                'NOTE: this will ignore the --genome_ids option.')
        .option('-f, --force [value]', 'Force to update cached data')
        .option('-d, --data_api [value]', 'Use given Data API endpoint, instead of SOLR directly.')
        .option('-e, --solr [value]', 'Use SOLR to grab data.  Must provide endpoint ' +
            '(i.e., http://chestnut.mcs.anl.gov:8983/solr)')
        .option('--token [value]', 'Token, if Data API is being used')
        .parse(process.argv)


    const genomeIDs = opts.genome_ids || DEFAULT_ID_STR
    if (!opts.genome_ids && !opts.bulk) {
        console.error(`Warning: no genome_ids given. Using default: ${DEFAULT_ID_STR}'\n`)
    }

    if (!opts.data_api && !opts.solr_url) {
        console.error(`Must specify at least --date_api or --solr\n`)
        return;
    }


    // if bulk option is given, first get some genome_ids
    if (opts.bulk) {
        const query = `select?rows=25&wt=json`
        const url = `${opts.endpoint || DISTRIBUTE_URL}/genome/${query}`
        rp.post({
            url: url,
        }).then((res) => {
            console.log(res)
        }).catch((err) => {
            console.log('eeror', err)
        })

    }


    if (opts.data_api){
        console.error('The data_api option is not implemented')
        sys.exit();
    }
    else if (opts.solr) {
        genomeIDs.split(',').forEach(genome_id => {
            const reqs = KEY_CORES.map(core => dataCall(core, genome_id))
            all(reqs).then(body => {

                const dirname = `${BASE_DATA_DIR}/${genome_id}`
                createFolderSync(dirname)

                KEY_CORES.forEach((core, i) => {
                    writeFile(body[i], `${dirname}/${core}.json`)
                })
            })
        })
    }
}



function dataCall(core, genome_id){
    const def = Deferred()
    const query = `select?q=genome_id:${genome_id}&rows=250000&wt=json`
    const url = `${opts.endpoint || DISTRIBUTE_URL}/${core}/${query}`

    console.log("requesting: ", url)
    request.get({
        url: url,
        // headers: {
        //     'Accept': 'application/json',
        //     'Content-Type': 'application/solrquery+x-www-form-urlencoded',
        //     'Authorization': opts.token || ''
        // },
        json: true
    }, function(error, resp, body){
        if (error){
            def.reject(error)
            return;
        }

        def.resolve(body.response.docs)
    })

    return def.promise
}


function createFolderSync(dirname){
    if (!fs.existsSync(dirname) && opts.force == true){
        fs.rmdirSync(dirname)
    }

    if (!fs.existsSync(dirname)) {
        fs.mkdirSync(dirname)
    }
}

function writeFile(json, filePath) {
    fs.writeFile(filePath, JSON.stringify(json, null, 4), 'utf8', () => {
        console.log('Wrote:', filePath)
    })
}