var PublicFacet = exports.PublicFacet = require("./PublicFacet");
var UserFacet = exports.UserFacet = require("./UserFacet");

exports.facets  = {
	/* by default we're generating a Public and User facet for each user */
	/* if a priv facet is added in here, it will get used instead */
	genome: {
		public: PublicFacet({
			doSomething2: function(b,c /*exposed*/){
				console.log("foo");
			},
			properties: "*",
		}),
		user: UserFacet({
			post:true,
			properties:["name"]
		})
	}
}
