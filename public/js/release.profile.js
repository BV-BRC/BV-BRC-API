var profile = {      
	basePath: "./", 
	layerOptimize: "closure", 
	cssOptimize:"comments.keepLines",
	releaseDir: "./release",
	stripConsole: "all",
	mini: true,
	hasReport: true,
	selectorEngine: "lite",
	staticHasFeatures:{
		"dojo-firebug": false,
		"dojo-debug-messages":true,
		'dojo-trace-api':false,
		'dojo-log-api':true,
		"async": true
	},
	plugins: {
		"xstyle/css": "xstyle/build/amd-css"
	},

	packages:[ 
		{ 
			name: "dojo", 
			location: "./dojo" 
		}, 
		{ 
			name: "dijit", 
			location: "./dijit" 
		},
		{ 
			name: "dojox", 
			location: "./dojox" 
		},
		{ 
			name: "cid", 
			location: "./cid"
		},
		{ 
			name: "dgrid", 
			location: "./dgrid"
		},
		{ 
			name: "put-selector", 
			location: "./put-selector"
		},
		{ 
			name: "xstyle", 
			location: "./xstyle"
		},
		{ 
			name: "dbind", 
			location: "./dbind"
		},
		{ 
			name: "rql", 
			location: "./rql"
		}
	
	], 

	layers: {             
                "cid/layer/p3api": {
                        include: [
				"cid/widget/WorkspaceManager", 
				"cid/widget/PatricHeader",
				"cid/widget/BorderContainer",
				"cid/app/apiexplorer",
                                "put-selector/put",
                                "dijit/_base",
                                "dijit/form/ComboButton",
                                "dijit/form/RadioButton",
                                "dijit/CheckedMenuItem",
				"dojo/dnd/AutoSource",
				"dijit/TooltipDialog",
				"dijit/PopupMenuItem",
				"dijit/MenuSeparator"

                        ]
                },
	}
};

