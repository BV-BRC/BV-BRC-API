var debug = require("debug")("p3api-server:media/newick");
var when = require("promised-io/promise").when;
var config = require("../config");
// var es = require("event-stream");
var treeDir = config.get("treeDirectory");
var Deferred = require("promised-io/promise").defer;
var Path = require("path");
var fs = require("fs-extra");

function checkForFiles(list){
	var def = new Deferred();
	var id = list.pop();
	var file = Path.join(treeDir, id + ".newick");
	debug("Look for newick: ", file);
	fs.exists(file, function(exists){
		if(exists){
			def.resolve(file);
		}else{
			if(!list || list.length < 1){
				def.reject("Newick Not Found");
			}else{
				when(checkForFiles(list), function(f){
					def.resolve(f);
				}, function(err){
					def.reject(err);
				});
			}
		}
	});
	return def.promise;
}

module.exports = {
	contentType: "application/newick",
	serialize: function(req, res, next){
		if(req.call_collection == "taxonomy" && req.call_method == "get"){
			if(res.results && res.results.doc){
				var lids = res.results.doc.lineage_ids;
				when(checkForFiles(lids), function(file){
					fs.createReadStream(file).pipe(res);
				}, function(err){
					next(err);
					return;
				})

			}else{
				debug("Invalid Resposponse: ", res.results);
			}
		}else{
			next(new Error("Cannot retrieve newick formatted data from this source"));
		}
	}
};
