// Collections that need join-based access control (they reference genomes but don't have their own permission fields)
const joinAccessControlCollections = {
  protein_structure: { fromIndex: 'genome', from: 'genome_id', to: 'genome_id' }
}

module.exports = function (req, res, next) {
  if (req.call_method !== 'query') { return next() }

  req.call_params[0] = req.call_params[0] || '&q=*:*'

  // Check if this collection needs join-based access control
  const joinConfig = joinAccessControlCollections[req.call_collection]
  if (joinConfig) {
    // Use a Solr cross-collection join to filter by the referenced collection's access control
    if (!req.user) {
      req.call_params[0] = req.call_params[0] + `&fq={!join method=crossCollection from=${joinConfig.from} to=${joinConfig.to} fromIndex=${joinConfig.fromIndex}}public:true`
    } else {
      req.call_params[0] = req.call_params[0] + `&fq={!join method=crossCollection from=${joinConfig.from} to=${joinConfig.to} fromIndex=${joinConfig.fromIndex}}(public:true OR owner:${req.user} OR user_read:${req.user})`
    }
  } else if (!req.publicFree || (req.publicFree && (req.publicFree.indexOf(req.call_collection) < 0))) {
    if (!req.user) {
      req.call_params[0] = req.call_params[0] + '&fq=public:true'
    } else {
      req.call_params[0] = req.call_params[0] + ('&fq=(public:true OR owner:' + req.user + ' OR user_read:' + req.user + ')')
    }
  }

  next()
}
