var express = require('express')
var router = express.Router({ strict: true, mergeParams: true })
var config = require('../config')
var rql = require('solrjs/rql')
var debug = require('debug')('p3api-server:route/JBrowse')
var SolrQueryParser = require('../middleware/SolrQueryParser')
var RQLQueryParser = require('../middleware/RQLQueryParser')
var DecorateQuery = require('../middleware/DecorateQuery')
var PublicDataTypes = require('../middleware/PublicDataTypes')
var authMiddleware = require('../middleware/auth')
var APIMethodHandler = require('../middleware/APIMethodHandler')
var httpParams = require('../middleware/http-params')
var Limiter = require('../middleware/Limiter')

var apiRoot = config.get('jbrowseAPIRoot')

function generateTrackList (req, res, next) {
  return JSON.stringify({
    'tracks': [
      {
        'type': 'SequenceTrack',
        'storeClass': 'p3/store/SeqFeatureREST',
        'baseUrl': apiRoot + '/genome/' + req.params.id,
        'key': 'Reference sequence',
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
          'label': 'patric_id,gene', // "function( feature ) { return feature.get('patric_id') }" //both the function and the attribute list work. but label doesn't show using HTMLFeatures only CanvasFeatures
          'color': '#17487d'
        },
        'hooks': {
          // "modify": "function(track, feature, div) { div.style.padding='4px'; div.style.backgroundColor = ['#17487d','#5190d5','#c7daf1'][feature.get('phase')];}"
        },
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
          'label': 'refseq_locus_tag,gene,gene_id,protein_id,feature_type', // "function( feature ) { return feature.get('refseq_locus_tag') }", //label attribute doesn't seem to work on HTMLFeatures
          'color': '#4c5e22'
        },
        'hooks': {
          // "modify": "function(track, feature, div) { div.style.backgroundColor = ['#4c5e22','#9ab957','#c4d59b'][feature.get('phase')];}" //these don't seem to work on CanvasFeatures
        },
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

router.use(httpParams)
router.use(authMiddleware)
router.use(PublicDataTypes)

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
  function (req, res, next) {
    if (res.results && res.results.response && res.results.facet_counts.facet_ranges.start) {
      var binCounts = res.results.facet_counts.facet_ranges.start.counts.map(function (d) {
        if (typeof (d) === 'number') {
          return d
        }
      })
      var maxCount = Math.math(binCounts)

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
      req.call_params[0] += '&select(patric_id,refseq_locus_tag,gene,product,annotation,feature_type,protein_id,gene_id,genome_name,accession,strand,na_length,aa_length,genome_id,start,end,feature_id)'
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
        d.phase = (d.feature_type === 'CDS') ? 0 : ((d.feature_type === 'RNA') ? 1 : 2)
        d.start = d.start - 1
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
