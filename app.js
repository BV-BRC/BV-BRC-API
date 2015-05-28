var debug = require('debug')('p3api-server');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var dataTypeRouter = require("./routes/dataType");
var indexer = require("./routes/indexer");
var config = require("./config");
var cors = require('cors');

var app = module.exports =  express();

debug("APP MODE: ", app.get('env'))

require("./enableMultipleViewRoots")(app);
app.set('views', [
    path.join(__dirname, 'views'),
    path.join(__dirname, 'node_modules',"dme","views")
]);
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));

app.use(logger('dev'));

app.use(function(req,res,next){
	debug("APP MODE: ", app.get('env'));
	req.production = (app.get('env')=='production')?true:false
	next();
});

app.use(cookieParser());

app.use(cors({origin: true, methods: ["GET,PUT,POST,PUT,DELETE"], allowHeaders: ["range","accept","x-range","content-type", "authorization"],exposedHeaders: ['Content-Range', 'X-Content-Range'], credential: true, maxAge: 8200}));

app.use(express.static(path.join(__dirname, 'public')));

app.use("/js",express.static(path.join(__dirname, 'public/js')));

var collections = config.get("collections");

app.use('/indexer/:type', indexer);


app.param("dataType", function(req,res,next,dataType){
    if (collections.indexOf(dataType)!=-1){
        next();
	return;
    } 
    next("route");
})

app.use('/:dataType/', dataTypeRouter);


// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
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
app.use(function(err, req, res, next) {
    debug("Dev env error handler: ", " err status", err.status)
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

 debug("Launch Indexer");
if (config.get("enableIndexer")) {
	var indexer = require('child_process').fork(__dirname + "/bin/p3-index-worker");

	indexer.on("message", function(msg){
		debug("message from child",msg);
	});

	indexer.send({type: "start"});
}

require("replify")({name: "p3api", path: "./REPL"},app,{});
