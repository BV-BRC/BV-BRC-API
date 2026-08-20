const { buildPermissionFq } = require('../lib/permissionFilter')

module.exports = function (req, res, next) {
  if (req.call_method !== 'query') { return next() }

  req.call_params[0] = req.call_params[0] || '&q=*:*'

  const permissionFq = buildPermissionFq({
    collection: req.call_collection,
    user: req.user,
    publicFree: req.publicFree
  })

  if (permissionFq) {
    req.call_params[0] = req.call_params[0] + '&fq=' + permissionFq
  }

  next()
}
