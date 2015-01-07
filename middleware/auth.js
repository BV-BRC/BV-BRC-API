

var userIdRegex = /un=(\w+)/


var validateToken = function(token) {
	return true
}

module.exports = function(req, res, next) {
	if (req.headers && req.headers.authorization && validateToken(req.headers.authorization)) {
		var matches = req.headers.authorization.match(userIdRegex);
		if (matches && matches[1]) {
			req.user = matches[1];
		}
	}
	next();
}
