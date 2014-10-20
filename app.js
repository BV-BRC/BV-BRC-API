var debug = require('debug')('p3api-server');
var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var routes = require('./routes/index');
var users = require('./routes/users');
var apiEngine = require('dme');

var app = module.exports =  express();

debug("load dataModel");
dataModel = require('./dataModel');
require("dme/media/");
app.dataModel = dataModel;


//debug("app.config: ", JSON.stringify(app.config));
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'));

//expose the config file to the request objects
app.use(function(req,res,next){
	req.config=app.config;
	req.dataModel = app.dataModel;
	next();
});

//app.use(bodyParser.json());
//app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', routes);
//app.use('/users', users);

app.use(apiEngine(dataModel))

app.use(express.static(path.join(__dirname, 'public')));
app.use("/js",express.static(path.join(__dirname, 'public/js')));


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


