const debug = require('debug')('p3api-server:patchmiddleware')
const Solrjs = require('solrjs')
const jsonpatch = require('json-patch')
const Url = require('url')
const Http = require('http')
const { httpsRequest } = require('../util/http')
const Config = require('../config')
const Web = require('../web')
const SOLR_URL = Config.get('solr').post_url
const solrAgentConfig = Config.get('solr').shortLiveAgent
//const solrAgent = new Http.Agent(solrAgentConfig)

const solrAgent = Web.getSolrShortLiveAgent()

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
  'host_common_name',
  'host_group',
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
  'comments',
	'segment',
	'subtype',
	'h_type',
	'n_type',
	'h1_clade_global',
	'h1_clade_us',
	'h3_clade',
	'h5_clade',
	'ph1n1_like',
	'lineage',
	'clade',
	'subclade',
	'authors',
	'geographic_group',
	'lab_host',
	'nearest_genomes',
	'other_names',
	'outgroup_genomes',
	'passage',
	'reference_genome',
	'season',
	'state_province',
	'phenotype'
]

function postDocs (docs, type) {
  const parsedSolrUrl = Url.parse(SOLR_URL)
	console.log(`POSTING with `, parsedSolrUrl);

  return httpsRequest({
    hostname: parsedSolrUrl.hostname,
    port: parsedSolrUrl.port,
    method: 'POST',
    auth: parsedSolrUrl.auth,
    agent: solrAgent,
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    path: `/solr/${type}/update?wt=json&overwrite=true`
  }, JSON.stringify(docs))
}

module.exports = function (req, res, next) {
  if (!req._body || !req.body) {
    return next()
  }

  const patchBody = req.body
  const collection = req.params.dataType
  const target_id = req.params.target_id

  if (!collection) {
    return next(new Error('Missing Collection Type for update patch'))
  }

  if (req.publicFree.indexOf(collection) >= 0) {
    return next(new Error('Update cannot be applied to this data type'))
  }

  if (!target_id) {
    return next(new Error('Missing Target ID for update patch'))
  }

  const solrClient = new Solrjs(`${SOLR_URL}/${collection}`)
  solrClient.setAgent(solrAgent)
  solrClient.get(target_id).then((body) => {
    if (!body || !body.doc) {
	    console.log("RETURN 404");
      res.sendStatus(404)
	      res.end();
	    return;
    }

    const doc = body.doc

    if (req.user && ((doc.owner === req.user) || (doc.user_write.indexOf(req.user) >= 0))) {
      if (patchBody.some(function (p) {
        const parts = p.path.split('/')
        const val = userModifiableProperties.indexOf(parts[1])
	console.log(parts[1], val);
	      return val < 0;
      })) {
	    console.log("RETURN 406", patchBody);
        res.status(406).send('Patch contains non-modifiable properties')
	      res.end();
	      return;
      }

      debug('PATCH: ', patchBody)

      try {
        jsonpatch.apply(doc, patchBody)
      } catch (err) {
	      console.log("RETURN 406")
        res.status(406).send('Error in patching: ' + err)
	      res.end();
        return
      }

      delete doc._version_

	    console.log("POSTING", JSON.stringify(doc));
      postDocs([doc], collection).then((postRes) => {
        // debug(`post response:`, postRes)
        console.log(`post response:`, postRes)
	    console.log("RETURN 201");
        res.sendStatus(201)
	      res.end();
	      return;
      }, (postErr) => {
	      console.log(postErr);
	      console.log("RETURN 406")
        res.status(406).send(`Error storing patched document: ${postErr}`)
	      res.end();
	      return;
      })
    } else {
      if (!req.user) {
        debug('User not logged in, permission denied')
	      console.log("RETURN 401")
        res.sendStatus(401)
	      res.end();
	      return;
      } else {
        debug('User forbidden from private data')
	      console.log("RETURN 403")
        res.sendStatus(403)
	      res.end();
	      return;
      }
    }
  }, (err) => {
    console.error(`Error retrieving ${collection} with id ${target_id}. ${err}`)
    res.status(406).send('Error retrieving target')
    res.end()
  })
}
