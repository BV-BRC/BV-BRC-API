const debug = require('debug')('SOLRQueryParser')
const LuceneQueryParser = require('lucene-query-parser')

module.exports = function (req, res, next) {
  if (req.queryType === 'solr') {
    const request_url = req.call_params[0]
    const request_parts = request_url.split('&')
    const query_part = request_parts.filter((token) => {
      const key_val = token.split('=')
      return key_val[0] === 'q'
    })

    const query = decodeURIComponent(query_part[0]).replace(/[+]/gi, ' ')
    try {
      debug(`Solr Query: ${query}`)
      const results = LuceneQueryParser.parse(query)
      debug(results)
      next()
    } catch (err) {
      debug(`Error in parsing query: ${query}, ${err}`)
      res.status(400).send({ status: 400, message: `Error in parsing query: ${query}` })
    }
  } else {
    next()
  }
}
