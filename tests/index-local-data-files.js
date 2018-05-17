#!/usr/bin/env node
/**
 *
 * Example Usage(s):
 *   - load directory ./test-files into
 *      ./index-local-data-files.js
 *          -i ./test-files/                          (optional; default: ./data-files)
 *          -e http://localhost:8983/some/solr
 *          -o user@patricbrc.org                     (optional; change owner of all records)
 *
 */

const fs = require("fs"),
      opts = require('commander'),
      rp = require('request-promise'),
      util = require('util');

const readFile = util.promisify(fs.readFile);
const readDir = util.promisify(fs.readdir);

const BASE_DATA_DIR = './test-files';


if (require.main === module) {
    opts.option('-t, --token [value]', 'Token for private genome access')
        .option('-e, --endpoint [value]', 'Endpoint to index data at')
        .option('-i, --input [value]',
            `Directory to index into Solr; defaults to ${BASE_DATA_DIR}`)
        .option('-o, --owner [value]', 'Set new owner for data being indexed')
        .option('-p, --set_private', 'Set genomes as "public: false"')
        .parse(process.argv)

    if(!opts.endpoint) {
        console.error(`Must provide endpoint "-e" where data will be indexed`);
        return 1;
    }

    loadData(opts.input);
}


async function loadData(inputDir) {
    const baseDir = inputDir || BASE_DATA_DIR;
    const genomes = await readDir(baseDir);

    let genomeCount = genomes.length

    for (const [i, genome] of genomes.entries()){
        console.log(`Indexing genome ${genome}...`);
        var files = await readDir(`${baseDir}/${genome}`);

        for (const [i, file] of files.entries()) {
            let core = file.split('.')[0];
            let f = `${baseDir}/${genome}/${file}`;

            let body = await submit(core, f);
        }

        console.log(`Progress: ${((i+1) / genomeCount * 100).toFixed(2)}% \n`);
    }
}


function submit(core, filePath) {
    const query = 'update?versions=true&commit=true';
    const url = `${opts.endpoint}/${core}/${query}`;

    console.log(
        `Loading core ${core}` +  (opts.owner ? ` (Changing owner to: ${opts.owner})` : '')
    );
    return readFile(filePath, "utf8").then(function(data) {

        // set owner in every object
        let objs = JSON.parse(data);
        objs.forEach(o => {
            if (!('owner' in o)){
                console.error(`Error: no existing owner field found in object: ${filePath}`);
                return;
            }

            // set owner if needed
            if (opts.owner) o.owner = opts.owner;

            // set as private if needed
            if (opts.set_private) o.public = false;
        })

        console.log('attempting post...')
        return rp.post({
            url: url,
            json: objs
        }).then(body => {
            return body;
        }).catch(e => {
            console.error(e);
        })
    }).catch(e => console.error(e))
}



module.exports = loadData;

