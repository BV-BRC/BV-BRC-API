var express = require('express')
var router = express.Router()

/* GET home page. */
router.get('/', function (req, res) {
  res.render('index', { results: [], request: req, title: 'p3api' })
})

module.exports = router
