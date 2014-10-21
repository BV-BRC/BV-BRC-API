define([
	"dojo/_base/declare",
	"dojo/topic","dojo/on","dojo/dom","dojo/dom-class","dojo/dom-attr","dojo/dom-construct",
	"dijit/registry","dojo/request",
	"dojo/_base/Deferred","../widget/GlobalSearch",
	"cid/widget/PageGrid","dojo/store/JsonRest",
	"dojo/ready","./app"
],function(
	declare,
	Topic,on,dom,domClass,domAttr,domConstruct,
	Registry,xhr,
	Deferred,GlobalSearch,
	Grid,JsonRest,
	Ready,App
) {
	return declare([App], {
		launchGridColumns: null,

		startup: function(){
			this.inherited(arguments);
			if (this.launchGridColumns) {	
				var store = new JsonRest({
					target: window.location.pathname,
					idProperty:'feature_id',
					headers:{
						"accept": "application/json",
						"content-type": "application/json",
						'X-Requested-With':null
					}
				});

				var grid = new Grid({
					columns: this.launchGridColumns.map(function(col){
						return { label: col.toUpperCase(), field: col }
					}),
					store:store,
					query: window.location.search
				})
				domConstruct.place(grid.domNode, this.getCurrentContainer().containerNode, "last");
				grid.startup();	
				this.getApplicationContainer().layout();
			}
		}
	});
});
