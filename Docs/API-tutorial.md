# PATRIC Data API Tutorial

This document will demonstrate API usages. 



## Fetching data

PATRIC Data API supports REST style query, RQL and Apache Solr queries.

### REST style

For example, querying genome information for [Mycobacterium tuberculosis H37Rv genome](https://www.patricbrc.org/view/Genome/83332.12) will be like below (genome ID is 83332.12)

```
$ curl -H "Accept: application/json" -H "Content-Type: application/x-www-form-urlencoded" https://www.alpha.patricbrc.org/api/genome/83332.12
```

Returns a json.

```
{"plasmids":0,"contigs":0,"publication":"9634230,12368430",,,"bioproject_accession":"PRJNA224","document_type":"genome","assembly_accession":"GCA_000195955.2","_version_":1552608979231703000}
```

### RQL

```
$ curl -H "Accept: application/json" -H "Content-Type: application/rqlquery+x-www-form-urlencoded" https://www.alpha.patricbrc.org/api/genome/?eq%28genome_id,83332.12%29
```

Returns a json, but in array. Because this is **query** so the result can be multiple.

```
[{"plasmids":0,"contigs":0,"publication":"9634230,12368430",,,"bioproject_accession":"PRJNA224","document_type":"genome","assembly_accession":"GCA_000195955.2"}]
```

Also, please note that we have changed Content-Type to "application/**rqlquery+**www-form-urlencoded". This is how to tell API what my query type is.

As the query grows, maybe due to more conditions or more ids to look up, we may need to **POST** instead of GET.

```
$ curl -H "Accept: application/json" -H "Content-Type: application/rqlquery+x-www-form-urlencoded" -X POST -d "eq%28genome_id,83332.12%29" https://www.alpha.patricbrc.org/api/genome/
```

### Apache Solr style

```
$ curl -H "Accept: application/json" -H "Content-Type: application/solrquery+x-www-form-urlencoded" https://www.alpha.patricbrc.org/api/genome/?q=genome_id:83332.12
```

OR

```
$ curl -H "Accept: application/json" -H "Content-Type: application/solrquery+x-www-form-urlencoded" -X POST -d "q=genome_id:83332.12" https://www.alpha.patricbrc.org/api/genome/
```

This queries should return the same result to what we have using RQL.

For more details on RQL operators we support, please refer [README.md](https://github.com/PATRIC3/p3_api/blob/master/README.md). 

For more details on Apache solr query syntax, please refer [Standard Query Parser](https://cwiki.apache.org/confluence/display/solr/The+Standard+Query+Parser) from Apache Reference Guide.

