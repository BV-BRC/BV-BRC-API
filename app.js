var debug = require('debug')('p3api-server');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var routes = require('./routes/index');
var users = require('./routes/users');
var DataModel = require('./dataModel');
var config = require("./config");
var cors = require('cors');

require("dme/media/");

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

app.use(cors({origin: true, methods: ["GET,PUT,POST,PUT,DELETE"], allowHeaders: ["content-type", "authorization"],exposedHeaders: ['Content-Range', 'X-Content-Range'], credential: true, maxAge: 8200}));

app.use(express.static(path.join(__dirname, 'public')));

app.use("/js",express.static(path.join(__dirname, 'public/js')));

app.use([
    function(req,res,next){
        debug("Check Authentication Status, choose corresponding DataModel")
        if (req.user) {
            debug("Set DataModel to USER");
            req.DataModel = DataModel.user;
        }else if (req.user && req.user.isAdmin) {
            debug("Set DataModel to ADMIN");
            req.DataModel = DataModel.admin;
        }else{
            debug("Set DataModel to PUBLIC");
            req.DataModel = DataModel.public
        }

        next();
    },function(req,res,next){
        if (!req.DataModel){
            next(new Error("Invalid Root DataModel"));
            return;
        }
        if(!req.DataModel.match(req)){
            next("route");
            return;
        }

        req.DataModel.dispatch(req,res,next);
    }
])

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
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

require("replify")({name: "p3api", path: "./REPL"},app,{"DataModel":DataModel});
