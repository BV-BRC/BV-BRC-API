
## P3 API Testing Overview

#### Running P3 API Locally with Local Solr

1.  Install Solr. Follow steps in the patric_solr repo [here](https://github.com/PATRIC3/patric_solr#installation).

2.  Start Solr. _Note:_ It will probably be necessary for testing to allocate at least a couple GB to the JVM as follows.

```
./bin/solr restart -m 2048m -Dsolr.solr.home=<full_path_to_patric_solr> -Dlucene.version=5.3
```

3.  Start Redis.

```
redis-server
```

4.  Start p3_api using `npm start`, or

```
pm2 start app.js -i 3 --name "p3_api" --merge-logs -o p3_api_service.out.log -e p3_api_service.err.log
```

If the API is configured properly, `http://localhost:3001/health` should return "OK" with 200 status.


#### Loading test data

###### Recommended:

1) The following will download 50 'exemplary' genomes to `./test-files` and then index them at the provided endpoint using the `-e, --endpoint` option.

```
./load-test-solr.js -e http://localhost:8983/solr -g ./50-test-genome-ids.json -f ./test-files-public
```

2) Meanwhile, you can download/index a second second set of 50 genomes, and also set the owner to be a test user with the `-o, --owner` option.

```
./load-test-solr.js -o nconrad@patricbrc.org -e http://localhost:8983/solr -g ./50-test-genome-ids-2.json -f ./test-files-private --set-private
```
<br>

###### Some other scripts/examples:

Fetch 20 genomes (and associated cores for each) and write JSON

```
./generate-local-data-files.js --bulk=20 --output="./data-files"
```

Given a directory of genomes related files in `./test-files/`...

├── 86662.6/
│   ├── genome.json
│   ├── genome_amr.json
│   ├── genome_feature.json
│   ├── genome_sequence.json
│   ├── pathway.json
│   ├── sp_gene.json
│   └── subsystem.json
├── 872325.3/
│   ├── genome.json
...

...index them into Solr and set the "owner" fields:
```
./index-local-data-files.js -i ./test-files/ -e http://localhost:8983/some/solr --owner=user@patricbrc.org
```




#### Running Tests.

The following is an example of running permission tests using Mocha/Chai.

1.  Copy `tests/config.sample.json` to `tests/config.json` and add test token accordingly.

2.  Run!

```
npm run test-permissions
```

If successful, the resulting output will look something like this:

```
  Test Genome Permissions
    ✓ should return 404 without genome id (231ms)
    add new permissions (user1 with read and user2 with write)
      ✓ should return 200 with "OK" (6050ms)
      ✓ should have correct permissions on genome core (659ms)
    remove all permissions
      ✓ should return 200 with "OK" (6198ms)
      ✓ should have no permissions on genome core (167ms)
    test bad inputs
      ✓ should give 401 without token
      ✓ should give 401 if bogus token (201ms)
      ✓ should give 403 if not owner (197ms)
      ✓ should return 200 for invalid input (6296ms)
    ...
```


#### Adding Tests

More sets of tests can be added following the structure in `tests/`.
