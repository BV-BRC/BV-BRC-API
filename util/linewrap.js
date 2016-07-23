module.exports = function(str,linelen){
	if (!str){ str = "" }
	if (str.length <= linelen ){
		return str;
	}
	var out=[];
	var cur=0;
	while (cur < str.length){
		if (cur+linelen>str.length){
			out.push(str.slice(cur,str.length-1));
			cur = str.length;
		}else{
			out.push(str.slice(cur, cur + linelen))
			cur = cur + linelen;
		}
	}	
	return out.join("\n");	
}
