var express = require('express')
var router = express.Router()
var pkg = require("../package.json")
var config = require("../config")

/* GET home page. */
router.get('/', function (req, res) {
  res.render('index', { results: [], request: req, pkg:pkg,config:config, title: 'p3api' })
})

module.exports = router
