PATRIC 3 API SERVER

##Installation

	# git clone --recursive git@github.com:dmachi/p3api.git
	# cd p3api
	# npm install
	# cp p3api.conf.sample p3api.conf and modify as appropriate

##Running
	./bin/p3api-server  

##Running With Debugging Enabled
	DEBUG=p3api-server ./bin/p3api-server

###API Usage

The p3api server allows for direct retrieval of objects from the data source through HTTP GET request using the unique ID for each data type (i.e., genome_id for the Genome collections) as well as querying data sources using either RQL syntax or SOLR query syntax.  Queries can be submitted as GET requests (with the query in the URL) or as POST requests with the query contained in the request body.  The latter is useful for large queries which would exceed the maximum length of URLs supported by browsers/servers.

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
- gt(FIELD,VALUE) : Greater than
- lt(FIELD,VALUE) : Less than
- gte(FIELD,VALUE) : Greater than or equal to
- lte(FIELD,VALUE) : Less than or equal to
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

Requests can force the server to set content-dispostion (thereby forcing a browser to download the file) by adding &http_download onto the url.

 
