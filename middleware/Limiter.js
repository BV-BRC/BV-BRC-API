const MAX_LIMIT = 25000
const DEFAULT_LIMIT = 25
const DOWNLOAD_LIMIT = 2500000

module.exports = function (req, res, next) {
  if (req.call_method !== 'query') { return next() }
  let limit = MAX_LIMIT
  const q = req.call_params[0]
  const rowsRegPattern = /(&rows=)(\d*)/
  const groupRegPattern = /&group=true/
  const groupRegMatches = q.match(groupRegPattern)
  const rowsRegMatches = q.match(rowsRegPattern)
  let queryOffset
  if (groupRegMatches) {
    limit = 99999999
  } else {
    if (!rowsRegMatches) {
      limit = DEFAULT_LIMIT
    } else if (rowsRegMatches && typeof rowsRegMatches[2] !== 'undefined' && (rowsRegMatches[2] > DOWNLOAD_LIMIT) && req.isDownload) {
      limit = DOWNLOAD_LIMIT
    } else if (rowsRegMatches && typeof rowsRegMatches[2] !== 'undefined' && (rowsRegMatches[2] > MAX_LIMIT) && (!req.isDownload)) {
      limit = MAX_LIMIT
    } else {
      limit = rowsRegMatches[2]
    }
  }
  if (req.headers.range) {
    const rangeMatches = req.headers.range.match(/^items=(\d+)-(\d+)?$/)

    if (rangeMatches) {
      const start = rangeMatches[1] || 0
      const end = rangeMatches[2] || MAX_LIMIT
      const l = end - start
      if (l > MAX_LIMIT) {
        limit = MAX_LIMIT
      } else {
        limit = l
      }

      queryOffset = start
    }
  }

  if (rowsRegMatches) {
    req.call_params[0] = q.replace(rowsRegMatches[0], '&rows=' + limit)
  } else {
    req.call_params[0] = req.call_params[0] + '&rows=' + limit
  }

  if (queryOffset) {
    const offsetMatches = q.match(/(&start=)(\d+)/)
    if (!offsetMatches) {
      req.call_params[0] = req.call_params[0] + '&start=' + queryOffset
    }
  }

  next()
}
