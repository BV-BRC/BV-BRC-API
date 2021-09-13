const ValidateToken = require('p3-user/validateToken')
var config = require('../config')
const signingSubjectURL = config.get('signingSubjectURL')

module.exports = function (req, res, next) {
  if (!signingSubjectURL) {
    return next(new Error('Missing signingSubjectURL in config'))
  }
  if (!req.isAuthenticated || (req.isAuthenticated && !req.isAuthenticated())) {
    if (req.headers && req.headers['authorization']) {
      ValidateToken(req.headers['authorization'], signingSubjectURL)
        .then((valid) => {
          if (valid && valid.id) {
            req.user = valid.id
          }
          next()
        }, (err) => {
          console.error('Invalid Token Validation')
          next(err)
        })
    } else {
      next()
    }
  } else {
    next()
  }
}
