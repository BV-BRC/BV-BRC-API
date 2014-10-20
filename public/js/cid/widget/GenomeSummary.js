define([
	"dojo/_base/declare","dijit/_WidgetBase","dojo/on",
	"dojo/dom-class","./PatricTool","dojo/text!./templates/GenomeSummary.html",
	"dojo/string","./formatter"
], function(
	declare, WidgetBase, on,
	domClass,PatricTool,OverviewTemplate,
	dojoString,Formatter
){
	return declare([WidgetBase,PatricTool], {
		"baseClass": "GenomeSummary",
		dataModel: "genomesummary",
		"postCreate": function(){
			this.inherited(arguments);
			console.log("Genome Summary POST CREATE");
		},
		query: "&limit(-1)&facet((field,collection_date_f),(limit,3),(field,completion_date),(field,disease_f),(field,host_name_f),(field,genome_status_f),(field,isolation_country_f),(field,isolation_source))&facet((limit,1000),(pivot,(refseq_cds,genome_status)),(pivot,(brc_cds,genome_status)),(pivot,(rast_cds,genome_status)))",
		_toolData:null,
		overviewTemplate: OverviewTemplate,
		startup: function(){
                        if (this._started){return; }
                        this._started=true;
                        var _self=this;
                        this.getData({handleAs:"json"}).then(function(data){
                                if (_self.refresh) { _self.refresh(data) };
                        });
		},
		refresh: function(data) {
			console.log("Overview Template: ", this.overviewTemplate, Formatter);
			this.domNode.innerHTML = dojoString.substitute(this.overviewTemplate,this,null,Formatter);

/*
			data = data || this.data;
			var out = "Genome Summary<br>Filters:" + (this.activeFilter || "None") + "<br><br>";

			if(data) {out += "<pre>"+JSON.stringify(data,null,4) + "</pre>";}

			this.domNode.innerHTML=out;
*/
		}
	});
});
