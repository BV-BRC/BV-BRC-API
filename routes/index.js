var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res) {
  res.render('index', { request:req, title: 'Express' });
});

module.exports = router;
