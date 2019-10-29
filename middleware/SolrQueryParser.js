
module.exports = function (req, res, next) {
  if (!req.solr_query) {
    req.solr_query = req._parsedUrl.query
  }
  next()
}
