var validateToken = require('p3-user/validateToken')
var when = require('promised-io/promise').when
var debug = require('debug')('p3api-server:middleware/auth')

/*
var userIdRegex = /un=(\w+\@\w+(\.\w+))/

var validateToken = function(token) {
  return true
}
*/

/*
module.exports = function(req, res, next) {
  if (req.headers && req.headers.authorization && validateToken(req.headers.authorization)) {
    var matches = req.headers.authorization.match(userIdRegex);
    if (matches && matches[1]) {
      req.user = matches[1];
    }
  }
  next();
}
*/

module.exports = function (req, res, next) {
  if (!req.isAuthenticated || (req.isAuthenticated && !req.isAuthenticated())) {
    if (req.headers && req.headers['authorization']) {
      when(validateToken(req.headers['authorization']), function (valid) {
        if (valid && valid.id) {
          // debug("Valid Login: ", valid);
          req.user = valid.id
        }
        next()
      }, function (err) {
        debug('Invalid Token Validation')
        next(err)
      })
    } else {
      next()
    }
  } else {
    next()
  }
}
