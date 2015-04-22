define([
    'intern!object',
    'intern/chai!assert',
    'intern/dojo/request'
], function (registerSuite, assert, request) {
    var suite = {
        name: "SOLR Data Query"
    };

    var basicQueries = [
        ["&q=*:*&rows=10", function (data) {
            assert.strictEqual(data.response.docs.length, 10);
        }]
    ];

    var dataModel = {
        "genome": {
            queries: [
                ['q=*:*&rows=0&facet=true&json.facet=%7Bgenome_count:%7Brange:%7Bfield:completion_date,start:"2010-01-01T00:00:00.000Z",end:"2016-01-01T00:00:00.000Z",gap:"%2B1YEAR",other:"before"%7D%7D%7D', function (data) {
                    assert.strictEqual(data.facets.genome_count.buckets.length, 6);
                }]
            ]
        },
        "enzyme_class_ref": {},
        "gene_ontology_ref": {},
        "genome_feature": {
            queries: [
                ['q=*:*&rows=0&fq=feature_type:CDS+AND+annotation:PATRIC&fq={!join+from=genome_id+to=genome_id+fromIndex=genome}taxon_lineage_ids:83332&facet=true&json.facet={stat:{field:{field:figfam_id,limit:-1,allBuckets:true,facet:{genome_count:"unique(genome_id)"}}}}', function (data) {
                    assert.isDefined(data.facets.stat);
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue((data.facets.stat.buckets.length > 20));
                }]
            ]
        },

        "genome_sequence": {},
        "id_ref": {},
        "misc_niaid_gsc": {},
        "pathway": {
            queries: [
                ['q=genome_id:83332.12&rows=0&facet=true&json.facet={stat:{field:{field:genome_id,facet:{pathway_count:"unique(pathway_id)"}}}}}', function(data) {
                    assert.isTrue(data.facets.stat.buckets[0].pathway_count > 1);
                }],
                ['q=genome_id:83332.12&rows=0&fq=annotation:PATRIC&facet=true&json.facet={stat:{field:{field:pathway_id,sort:{ec_count:desc},facet:{ec_count:"unique(ec_number)",gene_count:"unique(feature_id)",field:{field:pathway_name}}}}}', function(data){
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 0, 'data.facets.stat.buckets is empty');
                }],
                ['q=annotation:PATRIC&fq={!join+from=genome_id+to=genome_id+fromIndex=genome}genome_status:(Complete+OR+WGS)+AND+taxon_lineage_ids:83332&rows=0&facet=true&json.facet={stat:{field:{field:pathway_id,limit:-1,facet:{ec_count:"unique(ec_number)",genome_count:"unique(genome_id)",genome_ec_count:"unique(genome_ec)"}}}}', function(data) {
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 0, 'data.facets.stat.buckets is empty');
                }]
            ]
        },
        "pathway_ref": {},
        "ppi": {},
        "protein_family_ref": {},
        "sp_gene": {},
        "sp_gene_evidence": {},
        "sp_gene_ref": {},
        "taxonomy": {
            queries: []

        },
        "transcriptomics_experiment": {},
        "transcriptomics_gene": {},
        "transcriptomics_sample": {}
    };

    var filter = [
        "user", "collection", "client", "genome_sequence", "host-resp", "misc_niaid_gsc",
        "proteomics_peptide", "proteomics_protein", "proteomics_experiment"
    ];

    Object.keys(dataModel).filter(function (x) {
        return filter.indexOf(x) == -1
    }).forEach(function (model) {
        var Model = dataModel[model];
        var queries = Model.queries ? basicQueries.concat(Model.queries) : basicQueries;
        queries.forEach(function (bq) {
            var query = bq[0];
            var handler = bq[1];
            suite["GET /" + model + "/?" + query] = function () {
                var dfd = this.async(120000);
                request('http://localhost:3001/' + model + '/?' + query, {
                    headers: {
                        accept: "application/solr+json",
                        "content-type": "application/solrquery+x-www-form-urlencoded"
                    }, handleAs: "json"
                }).then(dfd.callback(handler), dfd.reject.bind(dfd));
                return dfd;
            }
        });
    });

    Object.keys(dataModel).filter(function (x) {
        return filter.indexOf(x) == -1
    }).forEach(function (model) {
        var Model = dataModel[model];
        var queries = Model.queries ? basicQueries.concat(Model.queries) : basicQueries;
        queries.forEach(function (bq) {
            var query = bq[0];
            var handler = bq[1];
            suite["POST /" + model + "/" + query] = function () {
                var dfd = this.async(120000);
                request('http://localhost:3001/' + model + '/', {
                    method: "POST",
                    headers: {
                        accept: "application/solr+json",
                        "content-type": "application/solrquery+x-www-form-urlencoded"
                    },
                    handleAs: "json",
                    data: query
                }).then(dfd.callback(handler), dfd.reject.bind(dfd));
                return dfd;
            }
        });
    });

    registerSuite(suite);
});
