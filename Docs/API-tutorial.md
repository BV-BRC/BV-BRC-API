# PATRIC Data API Tutorial

This document demonstrates PATRIC Data API use cases. You can use `curl` or any client software such as [Chrome plugin REST client](https://chrome.google.com/webstore/detail/advanced-rest-client/hgmloofddffdnphfgcellkdfbfbjeloo).



## 1. Fetching data

PATRIC Data API supports REST style query, RQL and Apache Solr queries.

### REST style

For example, querying genome information for [Mycobacterium tuberculosis H37Rv genome](https://www.patricbrc.org/view/Genome/83332.12) will be like below (genome ID is 83332.12)

```
$ curl -H "Accept: application/json" \
-H "Content-Type: application/x-www-form-urlencoded" \
https://www.alpha.patricbrc.org/api/genome/83332.12
```

Returns a json.

```
{"plasmids":0,"contigs":0,"publication":"9634230,12368430",,,
"assembly_accession":"GCA_000195955.2","_version_":1552608979231703000}
```

### RQL

```
$ curl -H "Accept: application/json" \
-H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
"https://www.alpha.patricbrc.org/api/genome/?eq(genome_id,83332.12)"
```

Returns a json, but in array. This is correct behavior, since a **query** may or may not return multiple records.

```
[{"plasmids":0,"contigs":0,"publication":"9634230,12368430",,,
"bioproject_accession":"PRJNA224","document_type":"genome","assembly_accession":"GCA_000195955.2"}]
```

Also, please note that we have changed Content-Type to "application/**rqlquery+**www-form-urlencoded". This is how to tell API what my query type is.

As we have more and more conditions or IDs, we may need to **POST** instead of GET. Here is how to do.

```
$ curl -H "Accept: application/json" \
-H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
-X POST -d "eq(genome_id,83332.12)" \
https://www.alpha.patricbrc.org/api/genome/
```

### Apache Solr style

```
$ curl -H "Accept: application/json" \
-H "Content-Type: application/solrquery+x-www-form-urlencoded" \
https://www.alpha.patricbrc.org/api/genome/?q=genome_id:83332.12
```

OR

```
$ curl -H "Accept: application/json" \
-H "Content-Type: application/solrquery+x-www-form-urlencoded" \
-X POST -d "q=genome_id:83332.12" \
https://www.alpha.patricbrc.org/api/genome/
```

This queries should return the same result to what we have using RQL.

For more details on RQL operators we support, please refer [README.md](https://github.com/PATRIC3/p3_api/blob/master/README.md). 

For more details on Apache solr query syntax, please refer [Standard Query Parser](https://cwiki.apache.org/confluence/display/solr/The+Standard+Query+Parser) from Apache Reference Guide.



## 2. Faceting

[Faceting](https://cwiki.apache.org/confluence/display/solr/Faceting) is a apache solr feature that allows you categories your search results. For example, if you want to know how many features exist per different annotations in Mycobacterium tuberculosis H37Rv genome, facet is the right tool for you instead you fetch all the data and count by yourself.

### Solr

```
$ curl -H "Accept: application/solr+json" \
-H "Content-Type: application/solrquery+x-www-form-urlencoded" \
-X POST -d "q=genome_id:83332.12&rows=0&facet=true&facet.field=annotation&json.nl=map" \
https://www.alpha.patricbrc.org/api/genome_feature/
```

Now we have a little bit different query. Let me explain one by one.

* `Accept: application/solr+json` We added **solr** to tell API that we want the original solr result. The result will be simliar to the box below, even though I trimmed a lot. (e.g  "responseHeader"). But you should be able to see it when you do curl.
* What we used to have with `application/json` is a part of the result. "response" -> "docs". Currently this is empty because we asked so (&row=0).
* `&facet=true&facet.field=annotation` is a way to ask faceting. In the result, "facet_counts" -> "facet_fields" -> "annotation" will return the facetted count.
* `json.nl=map` is way of formating faceted result. With this option, you can have the result in key-value format. If you ommit it (default), your result will be in array. 
* Endpoint changed from `/genome/` to `/genome_feature/`. This is a different core (core is term in Solr. Equivalent RDBMS table)

```json
{
    "responseHeader": {},
    "response": {
        "numFound": 9957,
        "start": 0,
        "docs": []
    },
    "facet_counts": {
        "facet_fields": {
            "annotation": {
                "RefSeq": 5515,
                "PATRIC": 4442,
                "BRC1": 0
            }
        }
    }
}
```

### RQL

Equivalent RQL example,

```
curl -H "Accept: application/solr+json" \
-H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
-X POST -d "eq(genome_id,83332.12)&facet((field,annotation))&limit(1)&json(nl,map)" \
https://www.alpha.patricbrc.org/api/genome_feature/
```

