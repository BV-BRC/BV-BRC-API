const debug = require('debug')('p3api-server:cachemiddleware')
const conf = require('../config')
const when = require('promised-io/promise').when
const defer = require('promised-io/promise').defer
const jsonpatch = require('json-patch')
const solrjs = require('solrjs')
const SOLR_URL = conf.get('solr').url
const Request = require('request')

const userModifiableProperties = [
  'genome_status',
  'strain',
  'serovar',
  'biovar',
  'pathovar',
  'mlst',
  'other_typing',
  'culture_collection',
  'type_strain',
  'completion_date',
  'publication',
  'bioproject_accession',
  'biosample_accession',
  'assembly_accession',
  'sra_accession',
  'ncbi_project_id',
  'refseq_project_id',
  'genbank_accessions',
  'refseq_accessions',
  'sequencing_centers',
  'sequencing_status',
  'sequencing_platform',
  'sequencing_depth',
  'assembly_method',
  'isolation_source',
  'isolation_site',
  'isolation_comments',
  'collection_date',
  'collection_year',
  'isolation_country',
  'geographic_location',
  'latitude',
  'longitude',
  'altitude',
  'depth',
  'other_environmental',
  'host_name',
  'host_gender',
  'host_age',
  'host_health',
  'body_sample_site',
  'body_sample_subsite',
  'other_clinical',
  'antimicrobial_resistance',
  'antimicrobial_resistance_evidence',
  'gram_stain',
  'cell_shape',
  'motility',
  'sporulation',
  'temperature_range',
  'optimal_temperature',
  'salinity',
  'oxygen_requirement',
  'habitat',
  'disease',
  'additional_metadata',
  'comments'
]

function postDocs (docs, type) {
  var defs = []
  var def = new defer()
  var url = conf.get('solr').url + '/' + type + '/update?wt=json&overwrite=true&softCommit=true'

  Request(url, {
    json: true,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: docs
  }, (err, response, body) => {
    if (err || body.error) {
      console.log('Error POSTing to : ' + type + ' - ' + (err || body.error.msg))
      def.reject(err)
      return
    }

    def.resolve(true)
  })

  return def.promise
}

function solrCommit (type, hard) {
  var def = new defer()

  Request(conf.get('solr').url + '/' + type + '/update?wt=json&' + (hard ? 'commit' : 'softCommit') + '=true', {}, function (err, response, body) {
    if (err) { def.reject(err); return }
    def.resolve(true)
  })
  return def.promise
}

module.exports = function (req, res, next) {
  if (!req._body || !req.body) {
    return next()
  }

  var patch = req.body
  var collection = req.params.dataType
  var target_id = req.params.target_id

  if (!collection) {
    return next(new Error('Missing Collection Type for update patch'))
  }

  if (req.publicFree.indexOf(collection) >= 0) {
    return next(new Error('Update cannot be applied to this data type'))
  }

  if (!target_id) {
    return next(new Error('Missing Target ID for update patch'))
  }

  // console.log("Target Collection: ", collection, " obj id: ", target_id);

  var solr = new solrjs(SOLR_URL + '/' + collection)
  when(solr.get(target_id), (sresults) => {
    if (!sresults || !sresults.doc) {
      return
    }

    var results = sresults.doc

    console.log('results', results)

    if (req.user && ((results.owner === req.user) || (results.user_write.indexOf(req.user) >= 0))) {
      if (patch.some(function (p) {
        var parts = p.path.split('/')
        return (userModifiableProperties.indexOf(parts[1]) < 0)
      })) {
        res.status(406).send('Patch contains non-modifiable properties')
      }

      console.log('PATCH: ', patch)

      try {
        jsonpatch.apply(results, patch)
      } catch (err) {
        res.status(406).send('Error in patching: ' + err)
        return
      }

      console.log('Patched Results: ', results)
      delete results._version_

      when(postDocs([results], collection), function (r) {
        res.sendStatus(201)
      }, function (err) {
        res.status(406).send('Error storing patched document' + err)
      })
    } else {
      if (!req.user) {
        debug('User not logged in, permission denied')
        res.sendStatus(401)
      } else {
        debug('User forbidden from private data')
        res.sendStatus(403)
      }
    }
  }, (err) => {
    console.log('Error retrieving ' + collection + ' with id ' + target_id)
    res.status(406).send('Error retrieving target')
    res.end()
  })
}
