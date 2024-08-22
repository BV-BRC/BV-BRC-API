# Data API Notes during the Solr9 transition.

## On schemas -
We have configuration data used in multiple places:
 * Configuring solr
 * Setting default fields in data api

we cannot add to schema as sent to solr:

```
Error CREATEing SolrCore 'xgenome_shard1_replica_n1': Unable to create core [xgenome_shard1_replica_n1] Caused by: Invalid field property: x-display-default
```

Possible solution. Master schema document from which we create our solr and other schemas for various tools. We can start with the solr one
and simply augment with x-blah fields that are removed to generate the solr schema.
We can also then maintain a single master set of types since we need to be managing the XML anyway. 


## Query flow

In the dataType router, we flow the request through the following middlewares:

1.  RQLQueryParser. Translate RQL to Solr vformat if req.queryType = 'rql'

2.  Optional SORLQueryParser, commented out. Used for debugging.

3.  DecorateQuery. Add access control clauses to query.

4.  Limiter. Skipped if request call_method != query.
        Maximum and default limits defined here.

1.  ccc

## Request variables:

call_method:
 * query: set if post and content-type is application/x-www-form-urlencoded, or 
 * schema: set if incoming request is /schema
 * get: if have url like /genome/83332.12
 * stream
 * post:

ExtractCustomFields

Only for query or stream requests

If we have a fl= in the query, req.fieldSelection set to that

Otherwise, we have a hard coded set of headers (fieldHeader) and fields (fieldSelection) defined for each type
