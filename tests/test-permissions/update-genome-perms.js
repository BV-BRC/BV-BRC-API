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
        .option('-g, --genome_ids [value]', 'Genome IDs (comma seperated) to change perms for')
        .option('-e, --endpoint [value]', 'Data API endpoint (i.e., http://localhost:3001)')
        .parse(process.argv)

    if (!opts.genome_ids) {
        console.error(`No genome_ids given!\n`);
        return;
    }

    updatePerms(opts.genome_ids.split(','), opts.token);
}



function updatePerms(genomeIds, token, permissions) {
    console.log('updating permissions', genomeIds)
    const data = permissions || TEST_PERMS;
    const url = (opts.endpoint || DATA_API_URL) + '/permissions/genome/' + genomeIds.join(',');

    return rp.post({
        url: url,
        body: JSON.stringify(data),
        resolveWithFullResponse: true,
        headers: {
            "content-type": "application/json",
            "authorization": token || ''
        }
    }).then(res =>{
        console.log('response', res);
        return res;
    }).catch(error => {
        console.log('error', error.message);
        return error;
    })

}


module.exports = updatePerms;