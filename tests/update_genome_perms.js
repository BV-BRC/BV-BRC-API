#!/usr/bin/env node
const fs = require('fs')
const opts = require('commander')
const request = require('request')

const DATA_API_URL = 'http://localhost:3001'


if (require.main === module) {
    opts.option('-t, --token [value]', 'Token for private genome access')
        .option('-g, --genome_ids [value]', 'Genome IDs (comma seperated) to change perms for')
        .option('-e, --endpoint [value]', 'Data API endpoint (i.e., http://localhost:3001)')
        .parse(process.argv)

    if (!opts.genome_ids) {
        console.error(`No genome_ids given!\n`)
        return
    }


    updatePerms()
}


function updatePerms() {

    const genomeIds = opts.genome_ids.split(',')

    var data = [{
        user: "devuser2@patricbrc.org",
        permission: 'read'
    }, {
        user: "devuser3@patricbrc.org",
        permission: 'write'
    }]

    const url = (opts.endpoint || DATA_API_URL) + '/permissions/genome/' + genomeIds[0]

    console.log('\nURL:', url)

    request.post(url, {
        body: JSON.stringify(data),
        headers: {
            "content-type": "application/json",
            "authorization": opts.token || ''
        }
    }, (error, resp, body) => {
        if (error){
            console.log('ITS AN ERROR')
            console.error(error)
            return;
        }

        console.log(body)
    })

}