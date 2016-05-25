var express = require('express');
var router = express.Router({strict:true,mergeParams:true});
var defer = require("promised-io/promise").defer;
var when = require("promised-io/promise").when;
var All = require("promised-io/promise").all;
var config = require("../config");
var bodyParser = require("body-parser");
var debug = require('debug')('p3api-server:dataroute');
var httpParams = require("../middleware/http-params");
var authMiddleware = require("../middleware/auth");
var distributeQuery = require("../distributeQuery");

router.use(httpParams);
router.use(authMiddleware);

router.post("*", [
	bodyParser.json({extended:true}),
	function(req,res,next){
		console.log("req.body: ", req.body);
		var defs = [];
		res.results={};

		Object.keys(req.body).forEach(function(qlabel){
			var qobj = req.body[qlabel];
			res.results[qlabel]={};

			defs.push(when(distributeQuery(qobj.dataType,qobj.query,{accept: qobj.accept}), function(result){
				console.log("RES: ", qlabel, result);
				res.results[qlabel].result= result;
			}))

		})

		when(All(defs), function(){
			next();
		})

	},

	function(req,res,next){
		res.set("content-type", "application/json");
		res.end(JSON.stringify(res.results));
	}
])

module.exports = router;
