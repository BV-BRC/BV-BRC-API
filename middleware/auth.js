const ValidateToken = require('p3-user/validateToken')

module.exports = function (req, res, next) {
  if (!req.isAuthenticated || (req.isAuthenticated && !req.isAuthenticated())) {
    if (req.headers && req.headers['authorization']) {
      ValidateToken(req.headers['authorization'])
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
