var debug = require("debug")("p3api:datamodel");
var DataModel = require("dme/DataModel");
var models = require("./models");
var privilegeFacet = require("./privilegeFacet").facets;
var PublicFacet = require("./privilegeFacet").PublicFacet;
var UserFacet = require("./privilegeFacet").UserFacet;
var SolrStore = require("dme/store/solr").Store;
var conf = require('./config');

var dataModel = new DataModel();

Object.keys(models).forEach(function(key){
	var store = new SolrStore(key,{url: conf.get("solr:url"), primaryKey: models[key].prototype.primaryKey });
	var model = models[key];
	if (typeof model=='function'){
		model = models[key](store,{});
	}	

	if (privilegeFacet[key]){
		for(var pfk in privilegeFacet[key]) {
			var pf = privilegeFacet[key][pfk];
			pf.use(model);
		}
	}

	var privFacet = privilegeFacet[key] || {user: UserFacet({model:model}),public: PublicFacet({model:model})};
	dataModel.set(key,model,privFacet);
});


module.exports = dataModel;


