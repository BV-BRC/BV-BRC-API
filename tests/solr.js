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
                ['q=*:*&rows=0&fq=feature_type:CDS+AND+annotation:PATRIC&fq={!join+from%3Dgenome_id+to%3Dgenome_id+fromIndex%3Dgenome}taxon_lineage_ids:83332&facet=true&json.facet={stat:{field:{field:figfam_id,limit:-1,allBuckets:true,facet:{genome_count:"unique(genome_id)"}}}}', function (data) {
                    assert.isDefined(data.facets.stat);
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 20);
                }],
                ['q=accession%3ANC_000962&fq=annotation%3APATRIC+AND+%21%28feature_type%3Asource%29&rows=0&facet=true&facet.mincount=1&facet.range=start&f.start.facet.range.start=0&f.start.facet.range.end=10000000&f.start.facet.range.gap=10000', function(data) {
                    assert.isArray(data.facet_counts.facet_ranges.start.counts);
                    assert.isTrue(data.facet_counts.facet_ranges.start.counts.length > 0)
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
                ['q=annotation:PATRIC&fq={!join+from%3Dgenome_id+to%3Dgenome_id+fromIndex%3Dgenome}genome_status:(Complete+OR+WGS)+AND+taxon_lineage_ids:83332&rows=0&facet=true&json.facet={stat:{field:{field:pathway_id,limit:-1,facet:{ec_count:"unique(ec_number)",genome_count:"unique(genome_id)",genome_ec_count:"unique(genome_ec)"}}}}', function(data) {
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 0, 'data.facets.stat.buckets is empty');
                }],
                /* Enrichment queries */
                ['q=feature_id:(PATRIC.1408425.3.JADC01000010.CDS.144475.145623.rev OR PATRIC.1408426.3.JAGY01000006.CDS.73048.74187.rev OR PATRIC.1202451.3.ALVH01000010.CDS.41390.42535.fwd OR PATRIC.1095900.3.AKIP01000020.CDS.41701.42846.fwd)&rows=0&facet=true&json.facet={stat:{field:{field:pathway_id,limit:-1,facet:{gene_count:"unique(feature_id)"}}}}', function(data) {
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 0);
                }],
                ['q=genome_id:83332.12 AND pathway_id:(00230 OR 00240)&fq=annotation:PATRIC&rows=0&facet=true&json.facet={stat:{field:{field:pathway_id,limit:-1,facet:{gene_count:"unique(feature_id)"}}}}', function(data) {
                    assert.isArray(data.facets.stat.buckets);
                    assert.isTrue(data.facets.stat.buckets.length > 0);
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
        "transcriptomics_gene": {
            queries: [
                ['q=genome_id%3A83332.12&fq=%7B!correlation%20fieldId%3Drefseq_locus_tag%20fieldCondition%3Dpid%20fieldValue%3Dlog_ratio%20srcId%3DRv2429%20filterCutOff%3D0.4%20filterDir%3Dpos%20cost%3D101%7D&rows=0&json.nl=map&wt=json', function(data){
                    assert.isArray(data.correlation);
                    assert.isTrue(data.correlation.length > 0);
                    assert.isTrue(data.correlation.some(function(d){
                        return d.id == "Rv2429" && d.correlation == 1.0;
                    }))
                }]
            ]
        },
        "transcriptomics_sample": {}
    };

    var filter = [
        "user", "collection", "client", "genome_sequence", "host-resp", "misc_niaid_gsc",
        "proteomics_peptide", "proteomics_protein", "proteomics_experiment"
    ];
/*
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
*/
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
