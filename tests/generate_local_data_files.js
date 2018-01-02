#!/usr/bin/env node

const fs = require('fs')
const process = require('process')
const opts = require('commander')
const request = require('request')
const Deferred = require('promised-io/promise').Deferred
const when = require('promised-io/promise').when
const all = require('promised-io/promise').all

// const config = require('../config');
// const distributeURL = config.get('distributeURL');
const distributeURL = 'http://chestnut.mcs.anl.gov:8983/solr'

const keyCores = ['genome', 'genome_feature', 'genome_sequence']
const BASE_DATA_DIR = './data_files'

if (require.main === module){
    opts.option('-g, --genome_ids [value]', 'Genome IDs comma delimited')
        .option('-f, --force [value]', 'Force to update cached data')
        .option('--token [value]', 'Token for private genome access')
        .parse(process.argv)

    if (!opts.genome_ids) {
        console.error('Must supply genome ids')
        opts.help()
    }

    // const genome_ids = '1763.134,83332.349,205918.41,83332.228'
    const genome_ids = opts.genome_ids || ''

    genome_ids.split(',').forEach(genome_id =>{
        const reqs = keyCores.map(core => dataCall(core, genome_id))
        all(reqs).then(body => {
            
            const dirname = `${BASE_DATA_DIR}/${genome_id}`
            createFolderSync(dirname)

            keyCores.forEach((core, i) => {
                writeFile(body[i], `${dirname}/${core}.json`)
            })
        })
    })
}

function dataCall(core, genome_id){
    const def = Deferred()
    const query = `select?q=genome_id:${genome_id}&rows=250000&wt=json`

    console.log("requesting: ", `${distributeURL}/${core}/${query}`)
    request.get({
        url: `${distributeURL}/${core}/${query}`,
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
        // console.log(body)

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