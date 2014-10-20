define([
	"dojo/_base/declare","dijit/layout/TabContainer", "dojo/on",
	"dojo/dom-class","dojo/NodeList-dom",
	"./ProteinFamilyViewer","./PathwayViewer","./GenomeList",
	"./TranscriptomicsViewer","./DiseaseViewer",
	"./TaxonomyTreeViewer", "./PhylogenyViewer","./FeatureGrid",
	"./PublicationsGrid","dijit/layout/ContentPane","dojo/query",
	"dojo/text!./templates/TaxonOverview.html","dojo/string","./formatter",
	"dojo/dom-attr","dojo/topic"
], function(
	declare, TabContainer, on,
	domClass,nodeListDom,
	ProteinFamilyViewer,PathwayViewer,GenomeList,
	TranscriptomicsViewer,DiseaseViewer,
	TaxonomyTreeViewer,PhylogenyViewer,FeatureGrid,
	PublicationsGrid,ContentPane,Query,
	OverviewTemplate,dojoString,formatter,
	domAttr,Topic
){

	console.log("Formatters at TaxonomyViewer Create: ", formatter);
	return declare([TabContainer], {
		"class": "TaxonomyViewer TaxonTabContainer",
		"disabled":false,
		"startupTabs": null,
		"tabDefs": {
			"overview": {title: "Overview",ctor: ContentPane,prerenderedContentClass: "OverviewContent",template: OverviewTemplate},
			"taxonomyTree": {title: "Taxonomy",ctor: TaxonomyTreeViewer},
			"phylogeny": {title: "Phylogeny",ctor: PhylogenyViewer},
			"genomeList": {title: "Genome List",ctor: GenomeList},
			"featureTable": {title: "Feature Table",ctor: FeatureGrid},
			"proteinFamilies": {title: "Protein Families",ctor: ProteinFamilyViewer},
			"pathwayViewer": {title: "Pathways",ctor: PathwayViewer},
			"transcriptomics": {title: "Transcriptomics",ctor: TranscriptomicsViewer},
			"diseases": {title: "Diseases",ctor:DiseaseViewer},
			"publications": {title: "Publications",ctor: PublicationsGrid}
		},
		formatter: formatter,
		"data": null,
		"mainContentClass": "MainContent",
		constructor: function(){
			this._tab={};
		},
		_setDataAttr: function(data){
			console.log("Data: ", data);
			this.data = data;
			this.refresh();
		},


		refresh: function(){
			console.log("Refreshing...");
			Object.keys(this.tabDefs).forEach(function(key){
				var def = this.tabDefs[key];
				if (this._tab[key]) {
					if (def.template) {
						var c = dojoString.substitute(def.template, this,null, this.formatter);
						this._tab[key].set("content", c);
					}else{
						this._tab[key].set("data",this.data);
					}	
				}
			},this);	
		},

		buildRendering: function(){
			this.inherited(arguments);
			var x = Query(".OverviewContent", this.domNode).orphan();
			if (x.length>0) {
				this["_OverviewContent"] = x;
			}
		},

		postCreate: function(){
			this.inherited(arguments);
			if (this.startupTabs){
				var tabs = Object.keys(this.tabDefs).filter(function(t){ return this.startupTabs.indexOf(t) },this).map(function(t){
					this.tabDefs[t].id = t;
					return this.tabDefs[t];
				},this);
			}else{
				var tabs = Object.keys(this.tabDefs).map(function(t){
					this.tabDefs[t].id=t;
					return this.tabDefs[t];
				},this);
			}
			tabs.forEach(function(tab){
				if (typeof tab.ctor == "string") {
					console.warn("Need to Load Tab Class or Add into requires: ", tab.ctor);
					return;
				}
				var t = this._tab[tab.id] =  new tab.ctor({"class": this.mainContentClass, title: tab.title});
				if (tab.prerenderedContentClass && this["_"+tab.prerenderedContentClass]) {
					this["_"+tab.prerenderedContentClass].place(t.containerNode);	
				}else if (tab.template && this.data){
					var c = dojoString.substitute(tab.template, this,null,this.formatter);
					t.set("content", c);
				}
				this.addChild(t);	
			},this);	

			var _self=this;
			this.on("a:click", function(evt){
				var dest = domAttr.get(evt.target,'href');
				var rel = domAttr.get(evt.target, "rel");
				evt.stopPropagation();
				evt.preventDefault();
				console.log("call nav", rel, dest);
				Topic.publish("/navigate", {widgetClass: rel, href: dest});
			});
		},

		selectChild: function(child){
			this.inherited(arguments);
			console.log("SelectedChild: ",child);
			if (child && child.getFilterPanel) {
				var panel = child.getFilterPanel();
				console.log("Got Panel: ", panel);
				if (panel) {
					Topic.publish("/overlay/left",{action: "set", panel: panel});
					return;
				}

			}
			Topic.publish("/overlay/left", {action: "hide"});
		}
	});
});
