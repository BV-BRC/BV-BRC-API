const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const Config = require('../config')
const CONTENT_FOLDER = Config.get('contentDirectory')
const HttpParamsMiddleWare = require('../middleware/http-params')
const Fs = require('fs-extra')
const Path = require('path')

Router.use(HttpParamsMiddleWare)

Router.get('*', function (req, res, next) {
  const file = Path.join(CONTENT_FOLDER, req.params[0])
	if (Fs.existsSync(file)) {
	if (req.headers["range"] && req.headers["range"].includes("bytes=")){
		parts = req.headers['range'].replace("bytes=", "").split("-")
		start = parseInt(parts[0])
		end = parseInt(parts[1])
		return Fs.createReadStream(file,{start: start, end: end}).pipe(res)
	}else{
		Fs.createReadStream(file).pipe(res)
	}
  } else {
    console.error(`${file} does not exits`)
    next('route')
  }
})

module.exports = Router
