var config = require("./config");
if(config.get("newrelic_license_key")){
	require('newrelic');
}

var debug = require('debug')('p3api-server:app');
var express = require('express');
var path = require('path');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var hpiSearchRouter = require("./routes/hpiSearch");
var dataTypeRouter = require("./routes/dataType");
var downloadRouter = require("./routes/download");
var multiQueryRouter = require("./routes/multiQuery");
var contentRouter = require("./routes/content");
var rpcHandler = require("./routes/rpcHandler");
var jbrowseRouter = require("./routes/JBrowse");
var genomePermissionRouter = require("./routes/genomePermissionRouter");
var indexer = require("./routes/indexer");
var cors = require('cors');
var http = require("http");

http.globalAgent.maxSockets = 1024;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var app = module.exports = express();
app.listen(config.get("http_port") || 3001)

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.enable("etag");
app.set('etag', "strong");

// debug("APP MODE: ", app.get('env'));

var reqId = 0;

var stats = null;

logger.token("qtime", function(req, res){
	var from = "QUERY ";
	if(req.cacheHit){
		from = "CACHE ";
	}

	if(!res.formatStart || !res.queryStart){
		return "";
	}

	return from + (res.formatStart.valueOf() - res.queryStart.valueOf());
});
/*
process.on("message", function(msg){
	if(msg && msg.type == "stats"){
		stats = msg.data;
	}
});
*/
/*
app.use(function(req, res, next){
	req.id = reqId++;

	process.send({"event": "RequestStart", id: req.id});

	res.on("close", function(){
		debug("Response Closed: ", req.id);
//		process.send({"event": "RequestComplete", id: req.id});
	});
	res.on("finish", function(){
//		debug("Response Finished: ", req.id);
		process.send({"event": "RequestComplete", id: req.id});
	});

	next();
});
*/
app.use(logger('[:date[iso]] :req[x-forwarded-for] :method :url :status :response-time [:qtime] ms - :res[content-length]'));

app.use(function(req, res, next){
	debug("APP MODE: ", app.get('env'));
	req.production = (app.get('env') == 'production') ? true : false
	next();
});

app.use(cookieParser());

app.use(cors({
	origin: true,
	methods: ["GET,POST,PUT,DELETE"],
	allowHeaders: ["if-none-match", "range", "accept", "x-range", "content-type", "authorization"],
	exposedHeaders: ['facet_counts', 'x-facet-count', 'Content-Range', 'X-Content-Range', "ETag"],
	credential: true,
	maxAge: 8200
}));

var collections = config.get("collections");

app.use('/indexer', indexer);

app.post("/", rpcHandler);

app.use("/health", function(req, res, next){
	res.write("OK");
	res.end();
});

app.use("/stats", function(req, res, next){
	if(stats){
		res.write(JSON.stringify(stats));
	}else{
		res.write("{}");
	}
	res.end();
});

app.use("/content", [
	contentRouter
])

app.use("/testTimeout", function(req,res,next){
	setTimeout(function(){
		res.send("OK");
		res.end();
	}, 60 * 1000 * 5);
});

app.use("/jbrowse/", [
	jbrowseRouter
]);

app.use("/query", [
	multiQueryRouter
]);

app.use("/hpi/search", [
	hpiSearchRouter
]);

app.param("dataType", function(req, res, next, dataType){
	if(collections.indexOf(dataType) != -1){
		next();
		return;
	}
	next("route");
});

app.use('/bundle/:dataType/', [
	downloadRouter
]);


app.use('/permissions/genome', [
	genomePermissionRouter
]);

app.use('/:dataType/', [
	dataTypeRouter
]);

// catch 404 and forward to error handler
app.use(function(req, res, next){
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

// error handlers

// development error handler
// will print stacktrace
if(app.get('env') === 'development'){
	app.use(function(err, req, res, next){
		debug("Dev env error handler: err status", err.status)
		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err
		});
	});
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next){
	debug("Dev env error handler: ", " err status", err.status)
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});
