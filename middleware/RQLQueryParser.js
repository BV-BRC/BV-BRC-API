const Rql = require('solrjs/rql')
const debug = require('debug')('RQLQueryParser')
const Expander = require('../ExpandingQuery')
const Config = require('../config')

const collectionUniqueKeys = Config.get('collectionUniqueKeys') || {}

// Sanitize error messages to prevent XSS
function sanitizeErrorMessage(message) {
  if (!message) return 'Invalid query'
  // Remove HTML tags and limit length
  return String(message).replace(/[<>"'&]/g, '').substring(0, 200)
}

// Extract cursor(TOKEN) from RQL query string and return { query, cursorMark }
function extractCursor (rqlQuery) {
  // Match cursor(...) operator - the token can contain any characters except unbalanced parens
  // Solr cursorMark tokens are typically base64-like strings with * for the initial request
  const cursorPattern = /&?cursor\(([^)]*)\)/
  const match = rqlQuery.match(cursorPattern)

  if (!match) {
    return { query: rqlQuery, cursorMark: null }
  }

  const cursorMark = decodeURIComponent(match[1])
  // Remove the cursor() operator from the query string
  let query = rqlQuery.replace(match[0], '')
  // Clean up leading/trailing ampersands left after removal
  query = query.replace(/^&+/, '').replace(/&&+/g, '&').replace(/&+$/, '')

  return { query, cursorMark }
}

// Ensure the sort clause includes the collection's unique key (required by Solr cursorMark)
function ensureSortHasUniqueKey (solrQuery, collection) {
  const uniqueKey = collectionUniqueKeys[collection]
  if (!uniqueKey) {
    return null // collection not in map, cannot support cursors
  }

  const sortPattern = /(&sort=)([^&]*)/
  const sortMatch = solrQuery.match(sortPattern)

  if (!sortMatch) {
    // No sort specified, add sort by unique key
    return solrQuery + '&sort=' + uniqueKey + '+asc'
  }

  const sortClause = sortMatch[2]
  // Check if the unique key is already in the sort clause
  // Sort fields look like: field+asc,field2+desc or field asc,field2 desc
  const sortFields = sortClause.split(',').map(function (s) {
    return s.trim().split(/[\s+]+/)[0]
  })

  if (sortFields.indexOf(uniqueKey) === -1) {
    // Append unique key to existing sort
    return solrQuery.replace(sortPattern, '$1' + sortClause + ',' + uniqueKey + '+asc')
  }

  return solrQuery
}

// Remove &start= parameter (Solr rejects start with cursorMark)
function removeStart (solrQuery) {
  return solrQuery.replace(/&start=\d+/, '')
}

module.exports = function (req, res, next) {
  if (req.queryType === 'rql') {
    req.call_params[0] = req.call_params[0] || ''

    // Extract cursor() before RQL expansion
    const { query: rqlWithoutCursor, cursorMark } = extractCursor(req.call_params[0])
    req.call_params[0] = rqlWithoutCursor

    if (cursorMark !== null) {
      // Validate that cursor is supported for this collection
      const collection = req.call_collection
      if (!collectionUniqueKeys[collection]) {
        return res.status(400).send({
          status: 400,
          message: 'Cursor pagination is not supported for collection: ' + collection
        })
      }

      // Cursors are incompatible with grouped queries
      if (req.call_params[0].indexOf('group(') !== -1) {
        return res.status(400).send({
          status: 400,
          message: 'Cursor pagination cannot be used with grouped queries'
        })
      }

      req.cursorMark = cursorMark
    }

    try {
      // catch parsing errors
      Expander.ResolveQuery(req.call_params[0], { req: req, res: res })
        .then((q) => {
          debug('Resolved Query: ', q)
          if (q === '()') { q = '' }
          const rq = Rql(q)
          const max = (req.isDownload) ? 999999999 : 25000
          req.call_params[0] = rq.toSolr({ maxRequestLimit: max, defaultLimit: 25 })
          debug(`Converted Solr Query: ${req.call_params[0]}`)

          // If cursor mode is active, modify the Solr query
          if (req.cursorMark) {
            // Ensure sort includes the unique key
            const adjusted = ensureSortHasUniqueKey(req.call_params[0], req.call_collection)
            if (adjusted === null) {
              return res.status(400).send({
                status: 400,
                message: 'Cursor pagination is not supported for collection: ' + req.call_collection
              })
            }
            req.call_params[0] = adjusted

            // Remove any start= parameter (incompatible with cursorMark)
            req.call_params[0] = removeStart(req.call_params[0])

            // Append cursorMark to the Solr query
            req.call_params[0] = req.call_params[0] + '&cursorMark=' + encodeURIComponent(req.cursorMark)
            debug(`Cursor Solr Query: ${req.call_params[0]}`)
          }

          req.queryType = 'solr'
          next()
        })
        .catch((err) => {
          console.error(`${err}`)
          const safeMessage = sanitizeErrorMessage(err.message)
          res.status(400).send({ status: 400, message: safeMessage })
        })
    } catch (err) {
      console.error(`[${(new Date()).toISOString()}] Unable to resolve RQL query. ${err.message}. Send 400`)
      const safeMessage = sanitizeErrorMessage(err.message)
      res.status(400).send({ status: 400, message: safeMessage })
    }
  } else {
    next()
  }
}
