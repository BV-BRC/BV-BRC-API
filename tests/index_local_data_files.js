#!/usr/bin/env node
/**
 *
 * Example Usage:
 * ./index_local_data_files.js
 *      --endpoint http://localhost:8983/some/solr/instance     (optional)
 *      --owner user@patricbrc.org                              (optional; change owner of all records)
 *
 */

const fs = require('fs')
const opts = require('commander')
const request = require('request')

const DISTRIBUTE_URL = 'http://localhost:8983/solr'
const BASE_DATA_DIR = './data_files'

if (require.main === module){
    opts.option('-t, --token [value]', 'Token for private genome access')
        .option('-e, --endpoint [value]', 'Endpoint to grab data from ' +
            '(i.e., http://localhost:8983/solr)')
        .option('-o, --owner [value]', 'Set new owner for data being indexed.')
        .parse(process.argv)

    const genomes = fs.readdirSync(BASE_DATA_DIR)

    genomes.forEach(genome => {
        console.log(genome)
        fs.readdirSync(`${BASE_DATA_DIR}/${genome}`).forEach(file => {
            const core = file.split('.')[0]

            submit(core, `${BASE_DATA_DIR}/${genome}/${file}`)
        })
    })
}

function submit(core, filePath){
    const query = 'update?versions=true&commit=true'
    const url = `${opts.endpoint || DISTRIBUTE_URL}/${core}/${query}`

    console.log("reading: ", filePath)
    console.log("requesting: ", url)

    if (opts.owner) {
        console.log(`(Changed owner to: ${opts.owner})`)
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                console.error(err)
                return;
            }

            // set owner in every object
            let objs = JSON.parse(data)
            objs.forEach(o => {
                if (!('owner' in o)){
                    console.error("Error: no existing owner field found in object: ${filePath}")
                    return;
                }
                o.owner = opts.owner
            })

            request.post({
                url: url,
                Authorization: opts.token || '',
                json: objs
            }, (error, resp, body) => {
                if (error){
                    console.error(error)
                    return;
                }
                console.log(body)
            })
        })
        return;
    }

    fs.createReadStream(filePath).pipe(
        request.post({
            url: url,
            Authorization: opts.token || ''
        }, (error, resp, body) => {
            if (error){
                console.error(error)
                return;
            }
            console.log(body)
        })
    )
}

