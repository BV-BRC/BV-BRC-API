({define:typeof define!=='undefined'?define:function(deps, factory){module.exports = factory(exports);}}).
define("rql/util/each", [], function(){
return each;

function each(array, callback){
	var emit, result;
	if (callback.length > 1) {
		// can take a second param, emit
		result = [];
		emit = function(value){
			result.push(value);
		};
	}
	for(var i = 0, l = array.length; i < l; i++){
		if(callback(array[i], emit)){
			return result || true;
		}
	}
	return result;
}
});
