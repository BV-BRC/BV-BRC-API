#!/usr/bin/env node
const fs = require('fs');
const opts = require('commander');
const rp = require('request-promise');


const DATA_API_URL = 'http://localhost:3001';
const TEST_PERMS = [{
    user: "devuser2@patricbrc.org",
    permission: 'read'
}, {
    user: "devuser3@patricbrc.org",
    permission: 'write'
}]


if (require.main === module) {
    opts.option('-t, --token [value]', 'Token for private genome access')
        .option('-g, --genome-ids [value]', 'Genome IDs (comma seperated) to change perms for')
        .option('-e, --endpoint [value]', 'Data API endpoint (i.e., http://localhost:3001)')
        .parse(process.argv)

    if (!opts.genome_ids) {
        console.error(`No genome_ids given!\n`);
        return;
    }

    updatePerms(opts.genomeIds.split(','), opts.token);
}



function updatePerms(genomeIDs, token, permissions) {
    genomeIDs = Array.isArray(genomeIDs) ? genomeIDs : [genomeIDs]

    const data = permissions || TEST_PERMS;
    const url = (opts.endpoint || DATA_API_URL) + '/permissions/genome/' + genomeIDs.join(',');

    return rp.post({
        url: url,
        body: JSON.stringify(data),
        resolveWithFullResponse: true,
        headers: {
            "content-type": "application/json",
            "authorization": token || ''
        }
    }).then(res =>{
        return res;
    }).catch(error => {
        return error;
    })

}


module.exports = updatePerms;