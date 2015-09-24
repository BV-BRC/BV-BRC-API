var debug = require('debug')('p3api-server-query-expander');
var when = require("promised-io/promise").when;
var defer = require("promised-io/promise").defer;
var All= require("promised-io/promise").all;
var Sequence= require("promised-io/promise").seq;
var LazyArray = require("promised-io/lazy-array").LazyArray;
var Query = require("rql/query").Query;
var request = require('request');
var config = require("./config");
var Request = require('request');

var workspaceAPI = config.get("workspaceAPI");

function getWorkspaceObject(id,opts) {
	var def = new defer();
//	console.log("in getWorkspaceObject: ", id);
//	console.log("wsAPI: ", workspaceAPI);	
//	console.log("opts req headers: ", opts.req.headers);
	Request({
		method: "POST",	
		url: workspaceAPI,
		json:true,
		body: {id:1,method:"Workspace.get",version:"1.1", params: [{objects: [decodeURIComponent(id)]}]},
		headers: {
			"accept": "application/json",
			"content-type": "application/json",
			"authorization": (opts && opts.req && opts.req.headers["authorization"])?opts.req.headers["authorization"]:""
		}
	},function(err, resObj,results){
		if (err) {
			console.log("Error retrieving object from workspace: ", err)
			
			def.reject(err);
			return;
		}
		if (results.result) {
			var R=[];
			results.result[0].map(function(o){
				var obj = (typeof o[1]=='string')?JSON.parse(o[1]):o[1];
//				console.log("obj: ", obj );
//				console.log("obj id_list: ", obj.id_list);
				Object.keys(obj.id_list).forEach(function(key){
					R = R.concat(obj.id_list[key].filter(function(y) { return !!y }));
				})						
			});
			if (R.length<1){
				R.push("NOT_A_VALID_ID");	
			}

			R = R.map(encodeURIComponent);
//			console.log("R: ", R[0]);
			def.resolve(R);
			return;
		}
		def.reject(false);
	});
	return def.promise;
}	

var LazyWalk = exports.LazyWalk = function(term,opts) {
//	console.log("LazyWalk term: ", term);
//	console.log("stringified term: ", Query(term).toString());
	var children;

	if (term && (typeof term == 'string')){	
//		console.log("TERM: ", term);
		return encodeURIComponent(term);	
	}

        if (typeof term == "boolean") {
                return term?"true":"false";
        }	

	if  ((term === 0) || (typeof term == "number")) {
		return term.toString()
	}

	if (term && term instanceof Array){
		var out =[];
		var defs = term.map(function(t){
			return when(LazyWalk(t,opts), function(t){
				out.push(t);
			});
		});
	
		return when(All(defs), function(defs){
//			console.log("Out: ", out);
			return "(" + out.join(",") + ")";	
		});	
//		console.log("LazyWalk term is instanceof Array: ", term);
//		console.log("Return Val: (" + term.join(",") + ")");
//		return "(" + term.join(",") +")"
	}
//	console.log("term: ", term, " type: ", typeof term, " args: ", term.args);	
	if (term && typeof term=="object") {
		if (term.name){
			if (term.args){
				term.args = term.args.map(function(t,index){
					return LazyWalk(t,opts)
				});

				return when(All(term.args), function(args){

					if (opts && opts.expansions && opts.expansions[term.name]) {
						var expanded = opts.expansions[term.name].apply(this,term.args);	
						//console.log("expanded: ", expanded);
						return when(ResolveQuery(expanded,opts,false), function(expanded){
							debug("Expanded POST WALK: "+ expanded);
							return expanded;
						});
					}
						if (term.name=="and" && term.args.length==1){
							return term.args[0];
						}else if (term.name=="and" && term.args.length==0){
							return "";
						}else if (term.name=="GenomeGroup") {
//							console.log("call getWorkspaceObject(): ", term.args[0]);
							return when(getWorkspaceObject(term.args[0],opts), function(ids){
								//console.log("getWSObject: ", ids);
								var out = "(" + ids.join(",") + ")"
								//console.log("out: ", out);
								return out;
							},function(err){
								console.log("Error Retrieving Workspace: ", err);	
								return "(NOT_A_VALID_ID)";
							})
						}else if (term.name=="FeatureGroup") {
							//console.log("call getWorkspaceObject(): ", term.args[0]);
							return when(getWorkspaceObject(term.args[0],opts), function(ids){
								//console.log("getWSObject: ", ids);
								var out = "(" + ids.join(",") + ")"
								//console.log("out: ", out);
								return out;
							},function(err){
								console.log("Error Retrieving Workspace: ", err);	
								return "(NOT_A_VALID_ID)";
								return err;
							})

						}else if (term.name=="query") {
							var modelId=args[0];
							var q= Query(args[1]);
							//console.log("q: ", q);
							var query = q.toString();
							var type="public";
							//console.log("typeof query: ", typeof query);
							//console.log("Do Query ", modelId, query);
							if (opts && opts.req &&  opts.req.user) { 
								if (opts.req.user.isAdmin){
									type="admin"
								}else{
									type="user"
								}	
							}
	
							//console.log(" get executor for  modelId: ", modelId, "type: ", type);
							var queryFn= DME.getModelExecutor("query", modelId, type);
							if (!queryFn) { throw new Error("Invalid Executor during LazyWalk for Query Resolver"); }
							return when(runQuery(queryFn,query,opts), function(results){
								//console.log("runQuery results len: ",results?results.length:"None");
							
								//console.log('results: ', results);	
								if (results instanceof Array) {
									//console.log("instance of array", results);
									return  "(" + results.join(',') + ")"
								}else{
									//console.log("non-array", results);
									return results;	
								}
							}, function(err){
								//console.log("SubQuery Error: ", err);	
							});	
						}	
						//console.log("Fall through: ", term, args);	
						return term.name + "(" + args.join(",") + ")";
				}, function(err){
					throw Error("Error Lazily Expanding Query: "+err);
				});
			}else{
				return term.name+"()";
			}
		}else if (term.args){
			return "(" + term.args.join(",") + ")"	
		}
	}
	throw Error("Invalid Term - " + JSON.stringify(term));
}

var queryCache={};

function runQuery(queryFn, query,opts){
	//console.log("Launch Query : ",query);
	if (opts && opts.req){
		if (opts.req.queryCache && opts.req.queryCache[query]) {
			return opts.req.queryCache[query];
		}
	}
	return when(queryFn(query,opts),function(qres){
		if (opts && opts.req){
			if (!opts.req.queryCache){
				opts.req.queryCache={}
			}
			opts.req.queryCache[query]=qres;
		}
		//console.log("qres len: ", qres.length);
		return qres;
	});
}

var ResolveQuery = exports.ResolveQuery = function(query,opts,clearCache) {
	//normalize to object with RQL's parser
	//console.log("ResolveQuery: ", query);
	
	if (typeof query== "string"){
		query= Query(query);
	}
		
	//walk the parsed query and lazily resolve any subqueries/joins	
	return when(LazyWalk(query,opts), function(finalQuery){
		//finalQuery will be a new string query	
		debug("Final Query: "+ finalQuery);
		if (opts&&opts.req.queryCache && clearCache){
			delete opts.req.queryCache;
		}
		return finalQuery;
	})
}

var Walk = exports.Walk = function(term,expansions) {
	if (!term) { return "" }
//	console.log("stringified term: ", Query(term).toString());
	var children;

	if (term && (typeof term == 'string')){
		return term;
	}

	if  (term && (typeof term == "number")) {
		return term.toString()
	}

	if (term && term instanceof Array){
//		console.log("Term is an array: ", term);
		return  "(" + term.join(",") + ")";
	}

	if (term && typeof term=="object") {
//		console.log("Term is object: ", term);
		if (term.name){
			if (term.args && (term.args.length>0)){
				
				term.args = term.args.map(function(t,index){
					//console.log("Walk SubTerm: ", t, " Expansions: ", expansions);
					return Walk(t,expansions)
				});

				return when(All(term.args), function(args){
					//console.log("term.args resolved: ", args);
					if (term.name && expansions[name]) {
						if (typeof expansion[name]=='function') {
							return expansion[name].apply(args);
						}	
					}
					return term.name + "(" + args.join(",") + ")";
				});
			}else{
				return term.name+"()";
			}
		}
	}
	throw Error("Invalid Term - " + JSON.stringify(term));
}



exports.ExpandQuery = function(query, expansions){
	expansions = expansions || _expansions || {}
	//normalize to object with RQL's parser
	console.log("ResolveQuery: ", query);
	
	if (typeof query== "string"){
		query= Query(query);
	}
//	console.log("Query: ", query);	
	//walk the parsed query and lazily resolve any subqueries/joins	
	return when(Walk(query,expansions), function(finalQuery){
		//finalQuery will be a new string query	
		//console.log("Expanded Query: ", finalQuery);
		return finalQuery;
	})
}
