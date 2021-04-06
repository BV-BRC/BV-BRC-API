var express = require('express')
var router = express.Router({ strict: true, mergeParams: true })
var config = require('../config')
var debug = require('debug')('p3api-server:route/JBrowse')
var RQLQueryParser = require('../middleware/RQLQueryParser')
var DecorateQuery = require('../middleware/DecorateQuery')
var PublicDataTypes = require('../middleware/PublicDataTypes')
var authMiddleware = require('../middleware/auth')
var APIMethodHandler = require('../middleware/APIMethodHandler')
var reqCounter = require('../middleware/ReqCounter')
var httpParams = require('../middleware/http-params')
var Limiter = require('../middleware/Limiter')

var apiRoot = config.get('jbrowseAPIRoot')
var distRoot = config.get('distributeURL')

function generateTrackList (req, res, next) {
  return JSON.stringify({
    'tracks': [
      {
        'type': 'SequenceTrack',
        'storeClass': 'p3/store/SeqFeatureREST',
        'baseUrl': apiRoot + '/genome/' + req.params.id,
        'key': 'Reference Sequence',
        'label': 'refseqs',
        'chunkSize': 20000,
        'maxExportSpan': 10000000,
        'region_stats': false,
        'pinned': true
      },
      {
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'storeClass': 'p3/store/SeqFeatureREST',
        'baseUrl': apiRoot + '/genome/' + req.params.id,
        'key': 'PATRIC Annotation',
        'label': 'PATRICGenes',
        'query': {
          annotation: 'PATRIC'
        },
        'style': {
          'showLabels': true,
          'showTooltips': true,
          'label': 'patric_id,gene',
          'color': '#17487d'
        },
        'glyph': 'function(feature) { return "JBrowse/View/FeatureGlyph/" + ( {"gene": "Gene", "mRNA": "ProcessedTranscript", "transcript": "ProcessedTranscript", "segmented": "Segments" }[feature.get("type")] || "Box" ) }',
        'subfeatures': true,
        'onClick': {
          'title': '{patric_id} {gene}',
          'label': "<div style='line-height:1.7em'><b>{patric_id}</b> | {refseq_locus_tag} | {alt_locus_Tag} | {gene}<br>{product}<br>{type}: {start} .. {end} ({strand})<br> <i>Click for detailed information</i></div>",
          'action': 'function(clickEvent){return window.featureDialogContent(this.feature);}'
        },
        'metadata': {
          'Description': 'PATRIC annotated genes'
        },
        'maxExportFeatures': 10000,
        'maxExportSpan': 10000000,
        'chunkSize': 100000,
        'region_stats': true
      },
      {
        'category': 'Gene and Protein',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'storeClass': 'p3/store/SeqFeatureREST',
        'baseUrl': apiRoot + '/genome/' + req.params.id,
        'query': {
          annotation: 'RefSeq'
        },
        'key': 'RefSeq Annotation',
        'label': 'RefSeqGenes',
        'style': {
          'showLabels': true,
          'showTooltips': true,
          'className': 'feature3',
          'label': 'refseq_locus_tag,gene,gene_id,protein_id,feature_type',
          'color': '#4c5e22'
        },
        'glyph': 'function(feature) { return "JBrowse/View/FeatureGlyph/" + ( {"gene": "Gene", "mRNA": "ProcessedTranscript", "transcript": "ProcessedTranscript", "segmented": "Segments" }[feature.get("type")] || "Box" ) }',
        'subfeatures': true,
        'onClick': {
          'title': '{refseq_locus_tag} {gene}',
          'label': "<div style='line-height:1.7em'><b>{refseq_locus_tag}</b> | {gene}<br>{product}<br>{type}: {start} .. {end} ({strand})<br> <i>Click for detailed information</i></div>",
          'action': 'function(clickEvent){return window.featureDialogContent(this.feature);}'
        },
        'metadata': {
          'Description': 'RefSeq annotated genes'
        },
        'maxExportFeatures': 10000,
        'maxExportSpan': 10000000,
        'region_stats': true
      }
    ],
    'names': {
      'url': 'names/',
      'type': 'REST'
    },
    'formatVersion': 1
  })
}

function generateSarsCov2TrackList (req, res, next) {
  return JSON.stringify({
    'formatVersion': 1,
    'names': {
      'type': 'REST',
      'url': 'names/'
    },
    'trackSelector': {
      'categoryOrder': 'Gene and Protein, Variants of Concern, Mutation Impact, Functional Features, Epitopes, Structural Features, Primers and Probes'
    },
    //"trackSelector" : 
    //  {"categoryOrder" : "Gene and Protein, Variants of Concern, Mutation Impact, Functional Features, Epitopes, Structural Features, Primers and Probes"},
    'include': distRoot + 'content/jbrowse/sars_colors.conf',
    'tracks': [
      {
        'category': 'Gene and Protein',
        'baseUrl': apiRoot + '/genome/2697049.107626',
        'chunkSize': 20000,
        'key': 'Reference Sequence',
        'label': 'refseqs',
        'maxExportSpan': 10000000,
        'pinned': true,
        'region_stats': false,
        'storeClass': 'p3/store/SeqFeatureREST',
        'type': 'SequenceTrack'
      },
      {
        'category': 'Gene and Protein',
        'urlTemplate': distRoot + 'content/jbrowse/GCF_009858895.2_ASM985889v3_genomic.sorted.gff.gz',
        'glyph': 'function(feature) { return "JBrowse/View/FeatureGlyph/" + ( {"gene": "Gene", "mRNA": "ProcessedTranscript", "transcript": "ProcessedTranscript", "segmented": "Segments" }[feature.get("type")] || "Box" ) }',
        'key': 'RefSeq Annotation',
        'label': 'RefSeqGFF',
        'maxExportFeatures': 10000,
        'maxExportSpan': 10000000,
        'metadata': {
          'Description': 'RefSeq annotated genes'
        },
        'region_stats': true,
        'storeClass': 'p3/store/SeqFeatureREST',
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { return feature.get("feature_type")=="CDS" ? "darkred" : "darkorange"; }',
          'label': 'product,protein_id,feature_type',
          'showLabels': true,
          'showTooltips': true
        },
        'subfeatures': true,
        'type': 'JBrowse/View/Track/CanvasFeatures'
      },

      // ***************************************
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          {
            'url': distRoot + 'content/jbrowse/polyclonal_max.bw',
            'name': 'Polyclonal escape fraction maximum',
            'nonCont': true,
            'fill': true,
            'color': '#85C1E9'
          },
          {
            'url': distRoot + 'content/jbrowse/polyclonal_median.bw',
            'name': 'Polyclonal escape fraction median',
            'nonCont': true,
            'fill': true,
            'color':
            '#E59866'
          }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'Polyclonal Sera Escape (Greaney 2021)',
        'label': 'Polyclonal Sera Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the human sera escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing human polyclonal sera.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the polyclonal plasma based on a FACS analysis post transfection (PMID: 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          {
            'url': distRoot + 'content/jbrowse/LYCoV016_max.bw',
            'name': 'LYCoV016 escape fraction maximum',
            'nonCont': true,
            'fill': true,
            'color': '#85C1E9'
          },
          {
            'url': distRoot + 'content/jbrowse/LYCoV016_median.bw',
            'name': 'LYCoV016 escape fraction median',
            'nonCont': true,
            'fill': true,
            'color': '#E59866'
          }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'LYCoV016 Ab Escape (Starr 2021)',
        'label': 'LYCoV016 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33592168, 33495308). The height of the overliad bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Eli Lilly LYCoV016 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/REGN10933_max.bw', 'name': 'REGN10933 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/REGN10933_median.bw', 'name': 'REGN10933 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'REGN10933 Ab Escape (Starr 2021)',
        'label': 'REGN10933 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33592168, 33495308). The height of overlaid the bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Regeneron REGN10933 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/REGN10987_max.bw', 'name': 'REGN10987 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/REGN10987_median.bw', 'name': 'REGN10987 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'REGN10987 Ab Escape (Starr 2021)',
        'label': 'REGN10987 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Regeneron REGN10987 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection(PMID: 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/REGN10933_REGN10987_max.bw', 'name': 'REGN10933+REGN10987 cocktail escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/REGN10933_REGN10987_median.bw', 'name': 'REGN10933+REGN10987 cocktail escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'REGN10933+REGN10987 Ab Cocktail Escape (Starr 2021)',
        'label': 'REGN10933+REGN10987 Ab Cocktail Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Regeneron REGN10933+REGN10987 antibody cocktail.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody cocktail based on a FACS analysis post transfection(PMID: 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/LYCoV555_max.bw', 'name': 'LYCoV555 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/LYCoV555_median.bw', 'name': 'LYCoV555 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'LYCoV555 Ab Escape (Starr 2021)',
        'label': 'LYCoV555 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33655250, 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Eli Lilly LYCoV555 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33655250, 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/LYCoV016_LYCoV555_max.bw', 'name': 'LYCoV016_LYCoV555 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/LYCoV016_LYCoV555_median.bw', 'name': 'LYCoV016_LYCoV555 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'LYCoV016+LYCoV555 Ab Cocktail Escape (Starr 2021)',
        'label': 'LYCoV016+LYCoV555 Ab Cocktail Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33655250, 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the Eli Lilly LYCoV016+LYCoV555 antibody cocktail.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody cocktail based on a FACS analysis post transfection (PMID: 33655250, 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/AZCoV22130_max.bw', 'name': 'AZ_COV2-2130 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/AZCoV22130_median.bw', 'name': 'AZ_COV2-2130 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'AZ_COV2-2130 Ab Escape (Dong 2021)',
        'label': 'AZ_COV2-2130 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33532768, 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the AstraZeneca COV2-2130 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33532768, 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/AZCoV22196_max.bw', 'name': 'AZ_COV2-2196 escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/AZCoV22196_median.bw', 'name': 'AZ_COV2-2196 escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'AZ_COV2-2196 Ab Escape (Dong 2021)',
        'label': 'AZ_COV2-2196 Ab Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33532768, 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the AstraZeneca COV2-2196 monoclonal antibody.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33532768, 33592168, 33495308).' }
      },
      {
        'category': 'Mutation Impact',
        'urlTemplates': [
          { 'url': distRoot + 'content/jbrowse/AZCoV22130_AZCoV22196_max.bw', 'name': 'AZ_COV2-2130+AZ_COV2-2196 cocktail escape fraction maximum', 'nonCont': true, 'fill': true, 'color': '#85C1E9' },
          { 'url': distRoot + 'content/jbrowse/AZCoV22130_AZCoV22196_median.bw', 'name': 'AZ_COV2-2130+AZ_COV2-2196 cocktail escape fraction median', 'nonCont': true, 'fill': true, 'color': '#E59866' }],
        'storeClass': 'jbrowse.repo/plugins/MultiBigWig/js/Store/SeqFeature/MultiBigWig',
        'autoscale': 'global',
        'style': { 'height': '100' },
        'max_score': '1',
        'colorizeAbout': 'true',
        'key': 'AZ_COV2-2130+AZ_COV2-2196 Ab Cocktail Escape (Dong 2021)',
        'label': 'AZ_COV2-2130+AZ_COV2-2196 Ab Cocktail Escape',
        'type': 'jbrowse.repo/plugins/MultiBigWig/js/View/Track/MultiWiggle/MultiXYPlot',
        'metadata': { 'description': 'These data tracks were constructed from the antibody escape data for the Spike protein RBD Mutant library (PMID: 32841599). The mutant library was constructed such that each site in the RBD was mutated with 19 different substitutions in the genetic background of Wuhan-Hu-1. The resulting library covers 3804 of the 3819 possible amino acid mutations in the RBD (PMID: 33532768, 33592168, 33495308). The height of the overlaid bar graph at each position represents the maximum (blue) and median (orange) escape fraction of all possible mutations at that position of the RBD when testing the AstraZeneca COV2-2130+COV2-2196 antibody cocktail.  The escape fraction refers to the proportion of yeast cells expressing the RBD mutation that escape the monoclonal antibody based on a FACS analysis post transfection (PMID: 33532768, 33592168, 33495308).' }
      },
      {
        "category" : "Variants of Concern",
        "maxExportFeatures": 10000, 
        "style": {
            "className": "feature3", 
           "color":'function(feature) { var f={uniprotColor}; return f(feature); }',
            "showLabels": true, 
            "showTooltips": true, 
            "borderWidth": 3
        }, 
        "storeClass": "JBrowse/Store/SeqFeature/GFF3Tabix", 
        "urlTemplate": distRoot + 'content/jbrowse/LoC_Markers_AA_v2.sorted.gff.gz', 
        "maxExportSpan": 10000000, 
        "label": "LoCMarkersAAVariations", 
        "key": "LoC Markers: AA Variations", 
        "type": "JBrowse/View/Track/CanvasFeatures", 
        "metadata": {
            "Description": "LoC Markers: AA Variations"
        },
        "displayMode":"normal"
        },
        {
          "category" : "Variants of Concern",
          "maxExportFeatures": 10000, 
          "style": {
              "className": "feature3", 
            "color":'function(feature) { var f={uniprotColor}; return f(feature); }',
              "showLabels": true, 
              "showTooltips": true, 
              "borderWidth": 3
          }, 
          "storeClass": "JBrowse/Store/SeqFeature/GFF3Tabix", 
          "urlTemplate": distRoot + 'content/jbrowse/LoC_Markers_NA_v2.sorted.gff.gz', 
          "maxExportSpan": 10000000, 
          "label": "LoCMarkersNTVariations", 
          "key": "LoC Markers: NT Variations", 
          "type": "JBrowse/View/Track/CanvasFeatures", 
          "metadata": {
              "Description": "LoC Markers: NT Variations"
          },
          "displayMode":"normal"
      },
      {
        'category': 'Epitopes',
        'urlTemplate': distRoot + 'content/jbrowse/SARS_bcell_epitopes_human_02FEB2021_all_v3.sorted.gff.gz',
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'key': 'Antibody Epitopes',
        'label': 'HumanBCellEpitopes',
        'maxExportFeatures': 10000,
        'maxExportSpan': 10000000,
        'metadata': {
          'Description': 'Human BCell Epitopes'
        },
        'style': {
          'className': 'feature3',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3,
          'color': 'red'

        },
        'subfeatures': true,
        'glyph': 'JBrowse/View/FeatureGlyph/Segments',
        'subParts': 'epitope',
        'topLevelFeatures': 'epitope_region',
        'displayMode': 'collapsed'
      },
      {
        'category': 'Primers and Probes',
        'urlTemplate': distRoot + 'content/jbrowse/SARS-CoV-2_Primers_Probes.sorted.gff.gz',
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'key': 'Primers and Probes',
        'label': 'PrimersandProbes',
        'maxExportFeatures': 10000,
        'maxExportSpan': 10000000,
        'metadata': {
          'Description': 'Primers and Probes'
        },
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={voColor}; return f(feature.data.parent); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3,
          'connectorColor': 'linen',
          'label': 'Variation'
        },
        'subfeatures': true,
        'glyph': 'JBrowse/View/FeatureGlyph/Segments',
        'subParts': 'CRISPR-Cas12,Multiplex_PCR,RT-dPCR,Singleplex_RT-PCR,MSSPE',
        'displayMode': 'normal'
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Region_of_interest.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Regionofinterest',
        'key': 'Region of Interest',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Region of interest'
        },
        'displayMode': 'compact'
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Topological_domain.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Topologicaldomain',
        'key': 'Topological Domain',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Topological domain'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Metal_ion-binding_site.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Metalionbindingsite',
        'key': 'Metal Ion Binding Site',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Metal ion binding site'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Transmembrane_region.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Transmembraneregion',
        'key': 'Transmembrane Region',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Transmembrane region'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Chain.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Chains',
        'key': 'Chains',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Chains'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Mutagenesis_site.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'MutagenesisSite',
        'key': 'Mutagenesis Site',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Mutagenesis Site'
        },
        'displayMode': 'collapsed'
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Active_site.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Activesite',
        'key': 'Active Site',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Active site'
        },
        'displayMode': 'compact'
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Modified_residue.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Modifiedresidue',
        'key': 'Modified Residue',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Modified residue'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Repeat.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'RepeatRegion',
        'key': 'Repeat Region',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Repeat Region'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Nucleotide_phosphate-binding_region.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Nucleotidephosphatebinding',
        'key': 'Nucleotide Phosphate Binding',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Nucleotide phosphate binding'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Disulfide_bond.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Disulfidebond',
        'key': 'Disulfide Bond',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Disulfide bond'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Short_sequence_motif.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Shortmotif',
        'key': 'Short Motif',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Short motif'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Signal_peptide.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Signalpeptide',
        'key': 'Signal Peptide',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Signal peptide'
        }
      },
      {
        'category': 'Structural Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Beta_strand.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Betastrand',
        'key': 'Beta Strand',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Beta strand'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Zinc_finger_region.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Zincfinger',
        'key': 'Zinc Finger',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Zinc finger'
        }
      },
      {
        'category': 'Structural Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Coiled-coil_region.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Coiledcoil',
        'key': 'Coiled Coil',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Coiled coil'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Domain.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Domains',
        'key': 'Domains',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Domains'
        },
        'displayMode': 'compact'
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Glycosylation_site.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'Glycosylationsite',
        'key': 'Glycosylation Site',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Glycosylation site'
        }
      },
      {
        'category': 'Structural Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Helix.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'HelixSecondaryStructure',
        'key': 'Helix',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Helix Secondary Structure'
        }
      },
      {
        'category': 'Functional Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Site.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'CleavageSites',
        'key': 'Cleavage Sites',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Cleavage Sites'
        }
      },
      {
        'category': 'Structural Features',
        'maxExportFeatures': 10000,
        'style': {
          'className': 'feature3',
          'color': 'function(feature) { var f={uniprotColor}; return f(feature); }',
          'showLabels': true,
          'showTooltips': true,
          'borderWidth': 3
        },
        'storeClass': 'JBrowse/Store/SeqFeature/GFF3Tabix',
        'urlTemplate': distRoot + 'content/jbrowse/Turn.sorted.gff.gz',
        'maxExportSpan': 10000000,
        'label': 'TurnSecondaryStructure',
        'key': 'Turn',
        'type': 'JBrowse/View/Track/CanvasFeatures',
        'metadata': {
          'Description': 'Turn Secondary Structure'
        }
      }
    ]
  })
}

router.use(httpParams)
router.use(authMiddleware)
router.use(PublicDataTypes)

router.get('/genome/2697049.107626/trackList', [
  function (req, res, next) {
    res.write(generateSarsCov2TrackList(req, res, next))
    res.end()
  }
])

router.get('/genome/:id/trackList', [
  function (req, res, next) {
    res.write(generateTrackList(req, res, next))
    res.end()
  }
])

router.get('/genome/:id/tracks', [
  function (req, res, next) {
    res.write('[]')
    res.end()
  }
])

router.get('/genome/:id/stats/global', [
  function (req, res, next) {
    req.call_collection = 'genome'
    req.call_method = 'query'
    req.queryType = 'rql'
    req.call_params = ['eq(genome_id,' + req.params.id + ')']
    debug('CALL_PARAMS: ', req.call_params)
    next()
  },
  RQLQueryParser,
  DecorateQuery,
  Limiter,
  APIMethodHandler,
  reqCounter,
  function (req, res, next) {
    if (res.results && res.results.response && res.results.response.docs) {
      // debug("solr result: ", res.results.response.docs);
      var featureCount = res.results.response.docs[0].patric_cds
      var genomeLength = res.results.response.docs[0].genome_length
      var featureDensity = (featureCount) / genomeLength
      // debug("patric_cds: ", featureCount);
      // debug("genome_length: ", genomeLength);
      res.json({ 'featureDensity': featureDensity, 'featureCount': featureCount })
      res.end()
    }
  }
])

router.get('/genome/:id/stats/region/:sequence_id', [
  function (req, res, next) {
    var start = req.query.start || req.params.start
    var end = req.query.end || req.params.end
    var annotation = req.query.annotation || req.params.annotation || 'PATRIC'
    req.call_collection = 'genome_feature'
    req.call_method = 'query'
    req.call_params = [[
      [// the query part has to come first.
        'accession:' + req.params.sequence_id,
        'annotation:' + annotation,
        '!(feature_type:source)',
        '(start:[' + start + '+TO+' + end + ']+OR+end:[' + start + '+TO+' + end + '])'
      ].join('+AND+'),
      'stats=true',
      'stats.field=na_length',
      'rows=0'
    ].join('&')]
    req.queryType = 'solr'
    next()
  },
  DecorateQuery,
  Limiter,
  APIMethodHandler,
  reqCounter,
  function (req, res, next) {
    if (res.results && res.results.stats) {
      var featureTotal = res.results.stats.stats_fields.na_length.sum
      var start = req.query.start || req.params.start
      var end = req.query.end || req.params.end
      var length = (end - start) + 1
      var featureDensity = featureTotal / length
      var featureCount = res.results.stats.stats_fields.na_length.count
      res.json({ 'featureDensity': featureDensity, 'featureCount': featureCount })
      res.end()
    }
  }
])

// only called when HTMLFeature track
router.get('/genome/:id/stats/regionFeatureDensities/:sequence_id', [
  function (req, res, next) {
    var start = req.query.start || req.params.start
    var end = req.query.end || req.params.end
    var annotation = req.query.annotation || req.params.annotation || 'PATRIC'
    var basesPerBin = req.query.basesPerBin || req.params.basesPerBin
    req.call_collection = 'genome_feature'
    req.call_method = 'query'
    req.call_params = [[
      'accession:' + req.params.sequence_id, // for subsequent processing in the Decorator the query part of this query has to come first
      'facet.range=start',
      'f.start.facet.range.end=' + end,
      'f.start.facet.range.start=' + start,
      'fq=annotation:' + annotation + '+AND+!(feature_type:source)',
      'facet.mincount=1',
      'rows=0',
      'f.start.facet.range.gap=' + basesPerBin,
      'facet=true'
    ].join('&')]
    req.queryType = 'solr'
    next()
  },
  DecorateQuery,
  Limiter,
  APIMethodHandler,
  reqCounter,
  function (req, res, next) {
    if (res.results && res.results.response && res.results.facet_counts.facet_ranges.start) {
      var binCounts = res.results.facet_counts.facet_ranges.start.counts.map(function (d) {
        if (typeof (d) === 'number') {
          return d
        }
      })
      var maxCount = Math.max(binCounts)

      res.json({
        'stats': {
          'basesPerBin': req.query.basesPerBin,
          'max': maxCount
        },
        'bins': binCounts
      })
      res.end()
    }
  }
])

router.get('/genome/:id/features/:seq_accession', [
  function (req, res, next) {
    // debug("req.params: ", req.params, "req.query: ", req.query);

    var start = req.query.start || req.params.start
    var end = req.query.end || req.params.end
    var annotation = req.query.annotation || req.params.annotation || 'PATRIC'
    req.call_collection = 'genome_feature'
    req.call_method = 'query'

    var st = 'between(start,' + start + ',' + end + ')'
    var en = 'between(end,' + start + ',' + end + ')'

    var over = 'and(lt(start,' + start + '),gt(end,' + end + '))'
    if (req.query && req.query['reference_sequences_only']) {
      req.call_collection = 'genome_sequence'

      req.call_params = ['and(eq(genome_id,' + req.params.id + '),eq(accession,' + req.params.seq_accession + '))']
      req.call_params[0] += '&limit(10000)'
    } else {
      req.call_params = ['and(eq(genome_id,' + req.params.id + '),eq(accession,' + req.params.seq_accession + '),eq(annotation,' + annotation + '),or(' + st + ',' + en + ',' + over + '),ne(feature_type,source))']
      req.call_params[0] += '&select(patric_id,refseq_locus_tag,gene,product,annotation,feature_type,protein_id,gene_id,genome_name,accession,strand,na_length,aa_length,genome_id,start,end,feature_id,segments,classifier_score,classifier_round)'
      req.call_params[0] += '&limit(10000)&sort(+start)'
    }
    req.queryType = 'rql'
    // debug("CALL_PARAMS: ", req.call_params);
    next()
  },
  RQLQueryParser,
  DecorateQuery,
  Limiter,
  APIMethodHandler,
  reqCounter,
  function (req, res, next) {
    if (req.call_collection === 'genome_sequence') {
      if (res.results && res.results.response && res.results.response.docs) {
        var refseqs = res.results.response.docs.map(function (d) {
          var end = req.query.end || req.params.end
          var start = req.query.start || req.params.start
          start = start < 0 ? 0 : start
          end = end > d.length ? d.length : end
          var sequence = d.sequence.slice(start, end + 1)
          var length = end - start
          return {
            length: length,
            name: d.accession,
            accn: d.accession,
            type: 'reference',
            score: d.gc_content,
            sid: d.genome_id,
            start: start,
            end: end,
            seq: sequence,
            seqChunkSize: length
          }
        })
        res.json({ features: refseqs })
        res.end()
      }
    } else {
      next()
    }
  },
  function (req, res, next) {
    // debug("res.results: ", res.results)
    if (res.results && res.results.response && res.results.response.docs) {
      var features = res.results.response.docs.map(function (d) {
        d.type = d.feature_type
        d.name = d.accession
        d.uniqueID = d.feature_id
        d.strand = (d.strand === '+') ? 1 : -1
        d.start = d.start - 1
        // format subfeatures for segmented feature
        if (d.segments.length > 1) {
          d.subfeatures = d.segments.map((segment, idx) => {
            const [start, end] = segment.split('..').map(val => parseInt(val))
            return {
              uniqueID: `${d.feature_id}_seg${idx}`,
              start: start - 1,
              end: end,
              strand: d.strand,
              protein_id: `${d.protein_id}_seg${idx}`,
              feature_type: 'CDS',
              type: 'CDS'
            }
          })
          // temporary switch
          // const pos = d.segments.map(seg => seg.split('..').map(pos => parseInt(pos))).reduce((r, el) => r.concat(el), [])
          // d.end = Math.max(...pos)
          // d.start = Math.min(...pos) - 1

          d.type = 'segmented'
        } else {
          delete d.segments
        }
        // temporary hack for aa and na sequence for tracks
        d.aa_sequence = ' '
        d.na_sequence = ' '
        return d
      })
      // debug("FEATURES: ", features)
      res.json({ features: features })
      res.end()
    }
  }
])

router.get('/genome/:id/refseqs', [
  function (req, res, next) {
    req.call_collection = 'genome_sequence'
    req.call_method = 'query'
    req.call_params = ['&eq(genome_id,' + req.params.id + ')&select(accession,length,sequence_id)&sort(+accession)&limit(1000)']
    req.queryType = 'rql'
    next()
  },
  RQLQueryParser,
  DecorateQuery,
  Limiter,
  APIMethodHandler,
  reqCounter,
  function (req, res, next) {
    // debug("Res.results: ", res.results);
    if (res.results && res.results.response && res.results.response.docs) {
      var refseqs = res.results.response.docs.map(function (d) {
        return {
          length: d.length,
          name: d.accession,
          accn: d.accession,
          sid: d.genome_id,
          start: 0,
          end: d.length,
          seqDir: '',
          seqChunkSize: d.length
        }
      })
      res.json(refseqs)
      res.end()
    }
  }
])

router.get('/genome/:id/names/', [
  function (req, res, next) {
    res.json([])
    res.end()
  }
])
module.exports = router
