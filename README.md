# PATRIC 3 API SERVER

## Installation
```
git clone https://github.com/PATRIC3/p3_api.git
cd p3api
npm install
cp p3api.conf.sample p3api.conf # modify as appropriate
```
## Running
```
npm start
```

## Running With Debugging Enabled
```
DEBUG=p3api-server npm start
```

## Running with pm2
```
./node_modules/pm2/bin/pm2 start app.js -i 3 --name "p3-api-service" --merge-logs -o p3_api_service.out.log -e p3_api_service.err.log
```

## Testing

For the latest documentation on setting up a test environment and running/writing tests, see [here](tests/README.md).


### API Usage

The p3api server allows for direct retrieval of objects from the data source through HTTP GET request using the unique ID for each data type (i.e., genome_id for the Genome collections) as well as querying data sources using either RQL syntax or SOLR query syntax.

Genome Retrieval Example:

	http://HOST:PORT/genome/GENOME_ID

Queries can be submitted as GET requests (with the query in the URL) or as POST requests with the query contained in the request body.  The latter is useful for large queries which would exceed the maximum length of URLs supported by browsers/servers.

Genome Feature Query Example:

	http://HOST:PORT/genome_feature/?eq(annotation,PATRIC)&select(genome_id,genome_name,annotation)&limit(10)&http_accept=application/json

Responses from queries are available in a number of formats:

- application/json : Returns an array of response objects
- application/solr+json : Returns an objects in the SOLR response format
- text/csv : Returns objects in comma separated values format. Columns are separated by ',', Multi-value columns are separated by ';', and rows are separated by "\n"
- text/tsv : Returns objects in tab separated values format.  Columns are separted by "\t", Multi-value columns are separated by ";", and rows are separted by "\n"
- application/vnd.openxmlformats : Returns objects for use in MS Excel
- application/dna+fasta : Returns DNA sequences for queries in FASTA format (this currently only makes sense for the 'genome_feature' collection)
- application/protein+fasta: Returns Protein sequences for queries in FASTA format (this currently only makes sense for the 'genome_feature' collection)
- application/gff :  Returns a genomic features in GFF format (This only makes sense for the 'genome_feature' collection)

The response format is determined by passing in the desired type in the HTTP Accept header of the request.  In cases where it is not possible to supply HTTP headers, the accept header can be specified by adding &http_accept=FORMAT  in the URL itself  (e.g.,  &http_accept=application/json)

The following operators are available for RQL Queries:

- eq(FIELD,VALUE) : Equals
- ne(FIELD,VALUE) : Not Equals
- gt(FIELD,VALUE) : Greater than
- lt(FIELD,VALUE) : Less than
- keyword(VALUE) : Text search (the specific fields that will be searched depends on the data sources' configuration)
- in(FIELD,(VALUE1,VALUE2,VALUE3)) : Returns objects whose FIELD contains any of the provided values
- and(EXPRESSION,EXPRESSION,...) : ANDs two or more expressions together
- or(EXPRESSION,EXPRESSION,...) : ORs two or more expressions together
- select(FIELD1,FIELD2,FIELD3,....) : Returns only the specified fields from result objects
- sort([+|-]FIELD,[+|-]FIELD2) : Sorts result data by field. Specify + or - to sort the results ascending or descending
- limit(COUNT,START) : Specifies a limit to the query where COUNT is the total number of objects to return and start is the starting index within the query to return from
- GenomeGroup(WORKSPACE_PATH) : Retrieves the GenomeGroup from WORKSPACE_PATH for use in a query (e.g., &in(genome_id,GenomeGroup(/path/to/my/group)) )
- FeatureGroup(WORKSPACE_PATH) : Retrieves the FeatureGroup from WORKSPACE_PATH for use in a query (e.g., &in(feature_id,FeatureGroup(/path/to/my/group)) )
- facet((FACET_PROPERTY,PROPERTY_VALUE),(FACET_PROPERTY,PROPERTY_VALUE),...) : Allows facets to be specified along with a query. Facet results are included in the HTTP response header when the response content-type is application/json and included in the response body for application/solr+json

HTTP Headers can be supplied normally or in a url by preceding the header name with "http_".  (e.g., &http_accept=application/json)

Requests can force the server to set content-dispostion (thereby forcing a browser to download the file) by adding &http_download=true onto the url.
This must be used in combination with sort(+UNIQUE_KEY) to increase the download limit to 25 million records.

## Deploy with Singularity

These instructions describe how build a singularity container for p3_api and deploy it.  The process requires singularity and jq.

### Build Singularity Container

```
./buildImage.sh
```
or
```
npm run build-image
```

These both generate a file with the name ```p3_api-<VERSION>.sif```.

### Using the singularity container.

The deployment requires two folders, a configuration folder and a log folder.  One can be a child of the other if desired. To bootstrap the
run the following command:

```
singularity instance start \
    --bind /PATH/TO/CONFIG/FOLDER:/config \
    --bind /PATH/TO/LOG/FOLDER:/logs \
    --bind /PATH/TO/TREES/FOLDER:/trees \
    --bind /PATH/TO/PUBLIC/GENOMES/FOLDER:/genomes \
    --bind /PATH/TO/QUEUE/FOLDER:/queue	\
    /path/to/p3_api-x.x.x.sif p3_api p3_api
```

NOTE: The last two parameters describe the singularity instance name.  The should both exist and they should ALWAYS be the same.

This command will start an instance of p3_api with a default config (that may fail to run). Additionally, it will populate the configuration
a number of additional files.  The p3_api.conf and pm2.config.js files are the p3_api configuration file and a configuration file to tell pm2
how to behave within the container.  Both of these may be edited and will not get replaced if they exist. An existing p3_api.conf should be
directly usable for the most part, but will need to have paths pointing at the tree folder, public genomes folder, and the indexer queue folder
updated to match the container internal mount points (/trees,/genomes,/queue). You may copy an existing p3_api.conf file into the configuration file before running the above command (with the aforementioned changes), and it will use that from the start.  A number of shell scripts for controlling the application will be generated the first time the command is run (or whenever start.sh doesn't exist).

- start.sh  : Starts the singularity container and the process manager within
- stop.sh   : Stops the process manager and the stops the container
- restart.sh: Calls ./stop.sh && ./start.sh
- start-indexer.sh: Starts the indexer
- stop-indexer.sh: Stops just the indexer
- reload.sh : Calls "reload" on the process manager.  This is for graceful reload after modifying the configuration file or for some other reason
- reload-api.sh: Gracefully reload the api only.
- scale.sh <desired instance count> : This modifies the number of running instances in the process manager to <desired instance count>
- pm2.sh <pm2 arguments> : This is a simple wrapper around the pm2 process manager running inside the container
- shell.sh  : This is simple wrapper around the shell command to connect to the instance
- p3-check-history.sh
- p3-check-integrity.sh
- p3-clear-index-queue.sh
- p3-index-completed.sh
- p3-index-count.sh
- p3-rebuild-history.sh
- p3-reindex.sh
- p3-update-history.sh

You will also note an instance.vars file.  This file contains variables pointing at the singularity image, instance name, and bind parameters
so that they won't need to be provided again.  Further, when an new image comes in,  modify instance.vars to point at the new image, stop the
existing service (./stop.sh), and then run start.sh to start again with the new image.

### Additional Notes

  - The same image may be used for multiple configuration files.  Deploy an image to alpha (by pointing at the alpha configuration) and when all is good,
    simply use the same image for beta and then production.
  - A configuration folder must NOT be used by multiple instances concurrently.  The configuration folder holds the pm2 specifics for that instance and will
    conflict if two instances use the same folder.
   - Log folder can be shared between multiple applications provided that the log file names themselves are unique.



