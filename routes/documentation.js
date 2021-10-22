var express = require('express')
var router = express.Router()
const config = require("../config");
const APIMethodHandler = require("../middleware/APIMethodHandler")
const documentation_data = require("./documentation_data.json")

var baseURL = config.get("publicURL")
if (baseURL[baseURL.length-1]==="/"){
  baseURL = baseURL.substring(0,baseURL.length-1)
}

const render_type = (field,schema) => {
  const types = schema.fieldTypes;
  var out;

  switch (field.type){
    case "pdouble":
    case "pfloat":
    case "plong":
    case "double":
    case "float":
    case "long":
        out="number";
        break;
    case "pdoubles":
    case "pfloats": 
      out="array of numbers"
      break;
    case "boolean":
      out="boolean"
      break;
    case "booleans":
      out="array of booleans"
      break;
    case "int":
    case "int":
      out="integer"
      break;
    case "pints":
      out="array of integers"
      break;
    case "string_ci":
      out="case insensitive string"
      break;
    case "pdate":
      out="date"
      break;
    case "pdates":
      out="array of dates"
      break;
    case "text_custom":
    case "string":
      out="string"
      break;
    case "text_general":
    case "strings":
      out="array of strings"
      break;
    
  }
  if (field.multiValued && !out.match(/array/i)){
    out = `array of ${out}s`
  }
  return out
}

/* DOCs home page. */
router.get('/', function (req, res) {
  res.render('documentation_home', { results: [], baseURL: baseURL, doc_data: documentation_data, config: config, request: req, title: 'Documentation Home' })
})

router.get('/:collection', [
  function(req,res,next){
    req.call_collection = req.params.collection
    req.call_method = "schema"
    next()
  },
  APIMethodHandler,
  function(req,res,next){
    console.log("res.results: ", res.results);
    next()
  },
  /* this is a dev response */
  // function(req,res,next){
    
  //   res.results = {}
  //   if (req.params.collection === "genome"){
  //     res.results = {"responseHeader":{"status":0,"QTime":0},"schema":{"name":"genome","version":1.6,"uniqueKey":"genome_id","fieldTypes":[{"name":"boolean","class":"solr.BoolField","sortMissingLast":true},{"name":"booleans","class":"solr.BoolField","sortMissingLast":true,"multiValued":true},{"name":"double","class":"solr.DoublePointField","docValues":true},{"name":"float","class":"solr.FloatPointField","docValues":true},{"name":"int","class":"solr.IntPointField","docValues":true},{"name":"long","class":"solr.LongPointField","docValues":true},{"name":"pdate","class":"solr.DatePointField","docValues":true},{"name":"pdates","class":"solr.DatePointField","docValues":true,"multiValued":true},{"name":"pdouble","class":"solr.DoublePointField","docValues":true},{"name":"pdoubles","class":"solr.DoublePointField","docValues":true,"multiValued":true},{"name":"pfloat","class":"solr.FloatPointField","docValues":true},{"name":"pfloats","class":"solr.FloatPointField","docValues":true,"multiValued":true},{"name":"pint","class":"solr.IntPointField","docValues":true},{"name":"pints","class":"solr.IntPointField","docValues":true,"multiValued":true},{"name":"plong","class":"solr.LongPointField","docValues":true},{"name":"plongs","class":"solr.LongPointField","docValues":true,"multiValued":true},{"name":"random","class":"solr.RandomSortField","indexed":true},{"name":"string","class":"solr.StrField","sortMissingLast":true,"docValues":true},{"name":"string_ci","class":"solr.SortableTextField","omitNorms":true,"sortMissingLast":true,"indexAnalyzer":{"tokenizer":{"class":"solr.KeywordTokenizerFactory"},"filters":[{"class":"solr.LowerCaseFilterFactory"},{"class":"solr.WordDelimiterGraphFilterFactory","catenateNumbers":"1","generateNumberParts":"1","stemEnglishPossessive":"1","splitOnCaseChange":"1","generateWordParts":"1","splitOnNumerics":"1","preserveOriginal":"1","catenateAll":"1","catenateWords":"1"},{"class":"solr.FlattenGraphFilterFactory"}]},"queryAnalyzer":{"tokenizer":{"class":"solr.KeywordTokenizerFactory"},"filters":[{"class":"solr.LowerCaseFilterFactory"},{"class":"solr.WordDelimiterGraphFilterFactory","catenateNumbers":"1","generateNumberParts":"1","stemEnglishPossessive":"1","splitOnCaseChange":"1","generateWordParts":"1","splitOnNumerics":"1","preserveOriginal":"1","catenateAll":"1","catenateWords":"1"}]}},{"name":"strings","class":"solr.StrField","sortMissingLast":true,"docValues":true,"multiValued":true},{"name":"text_custom","class":"solr.TextField","positionIncrementGap":"100","indexAnalyzer":{"tokenizer":{"class":"solr.WhitespaceTokenizerFactory"},"filters":[{"class":"solr.WordDelimiterGraphFilterFactory","catenateNumbers":"1","generateNumberParts":"1","splitOnCaseChange":"0","generateWordParts":"1","splitOnNumerics":"1","preserveOriginal":"1","catenateAll":"1","catenateWords":"1"},{"class":"solr.FlattenGraphFilterFactory"},{"class":"solr.LowerCaseFilterFactory"}]},"queryAnalyzer":{"tokenizer":{"class":"solr.WhitespaceTokenizerFactory"},"filters":[{"class":"solr.WordDelimiterGraphFilterFactory","catenateNumbers":"0","generateNumberParts":"1","splitOnCaseChange":"0","generateWordParts":"1","splitOnNumerics":"1","preserveOriginal":"0","catenateAll":"0","catenateWords":"0"},{"class":"solr.LowerCaseFilterFactory"}]}},{"name":"text_general","class":"solr.TextField","positionIncrementGap":"100","multiValued":true,"indexAnalyzer":{"tokenizer":{"class":"solr.StandardTokenizerFactory"},"filters":[{"class":"solr.LowerCaseFilterFactory"}]},"queryAnalyzer":{"tokenizer":{"class":"solr.StandardTokenizerFactory"},"filters":[{"class":"solr.LowerCaseFilterFactory"}]}}],"fields":[{"name":"_version_","type":"long","indexed":true,"stored":true},{"name":"additional_metadata","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"altitude","type":"string_ci","indexed":true,"stored":true},{"name":"antimicrobial_resistance","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"antimicrobial_resistance_evidence","type":"string_ci","indexed":true,"stored":true},{"name":"assembly_accession","type":"string","indexed":true,"stored":true},{"name":"assembly_method","type":"string_ci","indexed":true,"stored":true},{"name":"authors","type":"string_ci","indexed":true,"stored":true},{"name":"bioproject_accession","type":"string","indexed":true,"stored":true},{"name":"biosample_accession","type":"string","indexed":true,"stored":true},{"name":"biovar","type":"string_ci","indexed":true,"stored":true},{"name":"body_sample_site","type":"string_ci","indexed":true,"stored":true},{"name":"body_sample_subsite","type":"string_ci","indexed":true,"stored":true},{"name":"cds","type":"int","indexed":true,"stored":true},{"name":"cds_ratio","type":"float","indexed":true,"stored":true},{"name":"cell_shape","type":"string_ci","indexed":true,"stored":true},{"name":"checkm_completeness","type":"float","indexed":true,"stored":true},{"name":"checkm_contamination","type":"float","indexed":true,"stored":true},{"name":"chromosomes","type":"int","indexed":true,"stored":true},{"name":"clade","type":"string","indexed":true,"stored":true},{"name":"class","type":"string_ci","indexed":true,"stored":true},{"name":"coarse_consistency","type":"float","indexed":true,"stored":true},{"name":"collection_date","type":"string","indexed":true,"stored":true},{"name":"collection_year","type":"int","indexed":true,"stored":true},{"name":"comments","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"common_name","type":"string","indexed":true,"stored":true},{"name":"completion_date","type":"pdate","indexed":true,"stored":true},{"name":"contig_l50","type":"int","indexed":true,"stored":true},{"name":"contig_n50","type":"int","indexed":true,"stored":true},{"name":"contigs","type":"int","indexed":true,"stored":true},{"name":"core_families","type":"int","indexed":true,"stored":true},{"name":"core_family_ratio","type":"float","indexed":true,"stored":true},{"name":"culture_collection","type":"string_ci","indexed":true,"stored":true},{"name":"date_inserted","type":"pdate","default":"NOW","indexed":true,"stored":true},{"name":"date_modified","type":"pdate","default":"NOW","indexed":true,"stored":true},{"name":"depth","type":"string_ci","indexed":true,"stored":true},{"name":"disease","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"family","type":"string_ci","indexed":true,"stored":true},{"name":"fine_consistency","type":"float","indexed":true,"stored":true},{"name":"gc_content","type":"float","indexed":true,"stored":true},{"name":"genbank_accessions","type":"string_ci","indexed":true,"stored":true},{"name":"genome_id","type":"string","indexed":true,"stored":true},{"name":"genome_length","type":"int","indexed":true,"stored":true},{"name":"genome_name","type":"string_ci","indexed":true,"stored":true},{"name":"genome_quality","type":"string","indexed":true,"stored":true},{"name":"genome_quality_flags","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"genome_status","type":"string_ci","indexed":true,"stored":true},{"name":"genus","type":"string_ci","indexed":true,"stored":true},{"name":"geographic_group","type":"string_ci","indexed":true,"stored":true},{"name":"geographic_location","type":"string_ci","indexed":true,"stored":true},{"name":"gram_stain","type":"string_ci","indexed":true,"stored":true},{"name":"h_type","type":"int","indexed":true,"stored":true},{"name":"habitat","type":"string_ci","indexed":true,"stored":true},{"name":"host_age","type":"string_ci","indexed":true,"stored":true},{"name":"host_common_name","type":"string_ci","indexed":true,"stored":true},{"name":"host_gender","type":"string_ci","indexed":true,"stored":true},{"name":"host_group","type":"string_ci","indexed":true,"stored":true},{"name":"host_health","type":"string_ci","indexed":true,"stored":true},{"name":"host_name","type":"string_ci","indexed":true,"stored":true},{"name":"hypothetical_cds","type":"int","indexed":true,"stored":true},{"name":"hypothetical_cds_ratio","type":"float","indexed":true,"stored":true},{"name":"isolation_comments","type":"string_ci","indexed":true,"stored":true},{"name":"isolation_country","type":"string_ci","indexed":true,"stored":true},{"name":"isolation_site","type":"string_ci","indexed":true,"stored":true},{"name":"isolation_source","type":"string_ci","indexed":true,"stored":true},{"name":"kingdom","type":"string_ci","indexed":true,"stored":true},{"name":"lab_host","type":"string_ci","indexed":true,"stored":true},{"name":"latitude","type":"string_ci","indexed":true,"stored":true},{"name":"lineage","type":"string","indexed":true,"stored":true},{"name":"longitude","type":"string_ci","indexed":true,"stored":true},{"name":"mat_peptide","type":"int","indexed":true,"stored":true},{"name":"missing_core_family_ids","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"mlst","type":"string_ci","indexed":true,"stored":true},{"name":"motility","type":"string_ci","indexed":true,"stored":true},{"name":"n_type","type":"int","indexed":true,"stored":true},{"name":"ncbi_project_id","type":"string","indexed":true,"stored":true},{"name":"nearest_genomes","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"optimal_temperature","type":"string_ci","indexed":true,"stored":true},{"name":"order","type":"string_ci","indexed":true,"stored":true},{"name":"organism_name","type":"string_ci","indexed":true,"stored":true},{"name":"other_clinical","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"other_environmental","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"other_names","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"other_typing","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"outgroup_genomes","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"owner","type":"string","indexed":true,"stored":true},{"name":"oxygen_requirement","type":"string_ci","indexed":true,"stored":true},{"name":"p2_genome_id","type":"int","indexed":true,"stored":true},{"name":"partial_cds","type":"int","indexed":true,"stored":true},{"name":"partial_cds_ratio","type":"float","indexed":true,"stored":true},{"name":"passage","type":"string_ci","indexed":true,"stored":true},{"name":"pathovar","type":"string_ci","indexed":true,"stored":true},{"name":"patric_cds","type":"int","indexed":true,"stored":true},{"name":"phenotype","type":"string_ci","multiValued":true,"indexed":true,"stored":true},{"name":"phylum","type":"string_ci","indexed":true,"stored":true},{"name":"plasmids","type":"int","indexed":true,"stored":true},{"name":"plfam_cds","type":"int","indexed":true,"stored":true},{"name":"plfam_cds_ratio","type":"float","indexed":true,"stored":true},{"name":"public","type":"boolean","indexed":true,"stored":true},{"name":"publication","type":"string","indexed":true,"stored":true},{"name":"reference_genome","type":"string","indexed":true,"stored":true},{"name":"refseq_accessions","type":"string_ci","indexed":true,"stored":true},{"name":"refseq_cds","type":"int","indexed":true,"stored":true},{"name":"refseq_project_id","type":"string","indexed":true,"stored":true},{"name":"rrna","type":"int","indexed":true,"stored":true},{"name":"salinity","type":"string_ci","indexed":true,"stored":true},{"name":"season","type":"string","indexed":true,"stored":true},{"name":"segment","type":"string","indexed":true,"stored":true},{"name":"segments","type":"int","indexed":true,"stored":true},{"name":"sequencing_centers","type":"string_ci","indexed":true,"stored":true},{"name":"sequencing_depth","type":"string_ci","indexed":true,"stored":true},{"name":"sequencing_platform","type":"string_ci","indexed":true,"stored":true},{"name":"sequencing_status","type":"string_ci","indexed":true,"stored":true},{"name":"serovar","type":"string_ci","indexed":true,"stored":true},{"name":"species","type":"string_ci","indexed":true,"stored":true},{"name":"sporulation","type":"string_ci","indexed":true,"stored":true},{"name":"sra_accession","type":"string","indexed":true,"stored":true},{"name":"strain","type":"string_ci","indexed":true,"stored":true},{"name":"subclade","type":"string","indexed":true,"stored":true},{"name":"subtype","type":"string","indexed":true,"stored":true},{"name":"superkingdom","type":"string_ci","indexed":true,"stored":true},{"name":"taxon_id","type":"int","indexed":true,"stored":true},{"name":"taxon_lineage_ids","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"taxon_lineage_names","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"temperature_range","type":"string_ci","indexed":true,"stored":true},{"name":"text","type":"text_custom","multiValued":true,"indexed":true,"stored":false},{"name":"trna","type":"int","indexed":true,"stored":true},{"name":"type_strain","type":"string_ci","indexed":true,"stored":true},{"name":"user_read","type":"string","multiValued":true,"indexed":true,"stored":true},{"name":"user_write","type":"string","multiValued":true,"indexed":true,"stored":true}],"dynamicFields":[],"copyFields":[{"source":"*","dest":"text"}]}}
  //   }
  //   next()
  // },
  function (req, res) {
    if (res.results && res.results.schema){
      res.render('documentation_collection', { results: res.results, baseURL: baseURL,default_query_formatters: documentation_data.default_query_formatters, doc_data: documentation_data.collections[req.params.collection]?documentation_data.collections[req.params.collection]:{},collection: req.params.collection, render_type: render_type, config: config, request: req, title: `Documentation: ${req.params.collection}` })
    }else{
      res.render('documentation_collection_missing',{doc_data: documentation_data.collections[req.params.collection]?documentation_data.collections[req.params.collection]:{},collection: req.params.collection,config: config, request: req, title: `Documentation: ${req.params.collection}` })
    }
  }
])

module.exports = router
