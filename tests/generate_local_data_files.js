#!/usr/bin/env node
/**
 *
 * Example Usage:
 *  ./generate_local_data_files.js
 *      --endpoint http://chestnut.mcs.anl.gov:8983/solr
 *
 */

const fs = require('fs')
const process = require('process')
const opts = require('commander')
const request = require('request')
const Deferred = require('promised-io/promise').Deferred
const when = require('promised-io/promise').when
const all = require('promised-io/promise').all

const DISTRIBUTE_URL = 'http://chestnut.mcs.anl.gov:8983/solr'
const KEY_CORES = ['genome', 'genome_feature', 'genome_sequence', 'pathway', 'sp_gene', 'genome_amr']

const BASE_DATA_DIR = './data_files'
const DEFAULT_ID_STR = '1763.134,83332.349,205918.41,83332.228'

if (require.main === module){
    opts.option('-g, --genome_ids [value]', 'Genome IDs comma delimited')
        .option('-f, --force [value]', 'Force to update cached data')
        .option('-e, --endpoint [value]', 'Endpoint to grab data from ' +
            '(i.e., http://chestnut.mcs.anl.gov:8983/solr)')
        .option('--token [value]', 'Token for private genome access')
        .parse(process.argv)


    const genomeIDs = opts.genome_ids || DEFAULT_ID_STR
    if (!opts.genome_ids) {
        console.error(`Warning: no genome_ids given. Using default: ${DEFAULT_ID_STR}'\n`)
    }

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