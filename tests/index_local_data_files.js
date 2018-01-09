#!/usr/bin/env node

const fs = require('fs')

const request = require('request')
const Deferred = require('promised-io/promise').Deferred
const when = require('promised-io/promise').when
const all = require('promised-io/promise').all

const distributeURL = 'http://localhost:8983/solr'
const BASE_DATA_DIR = './data_files'

if (require.main === module){

    const genomes = fs.readdirSync(BASE_DATA_DIR)

    genomes.forEach(genome => {
        console.log(genome)
        fs.readdirSync(`${BASE_DATA_DIR}/${genome}`).forEach(file => {
            const core = file.split('.')[0]

            submit(core, `${BASE_DATA_DIR}/${genome}/${file}`) 
        })
    })
}

function submit(core, file){
    // const def = Deferred()
    // const query = 'update?versions=true&softCommit=true'
    const query = 'update?softCommit=true&openSearcher=false'

    console.log("reading: ", file)
    console.log("requesting: ", `${distributeURL}/${core}/${query}`)

    fs.createReadStream(file).pipe(
        request.post({
            url: `${distributeURL}/${core}/${query}`
        }, function(error, resp, body){
            if (error){
                console.error(error)
                // def.reject(error)
                return;
            }
            console.log(body)
            // def.resolve(body)
        })
    )
}
