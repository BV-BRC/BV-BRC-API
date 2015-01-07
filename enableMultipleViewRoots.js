// Usage:
// var express = require('express')
// require('enableMultipleViewRoots')(express)
var app = require("./app").app
var Path = require("path");

module.exports = function(app) {
  var old =app.get("view").prototype.lookup

  function lookup(view, options) {
//    console.log("Looking for view", view)
    options = options || {root: app.get("views")};
    // If root is an array of paths, let's try each path until we find the view
    if (options.root instanceof Array) {
      var opts = {}
      for (var key in options) opts[key] = options[key]
      var root = opts.root, foundView = null
  //    console.log("root.length", root)
      for (var i=0; i<root.length; i++) {
        opts.root = root[i]
   //     console.log("opts.root", opts.root)
        foundView = old.call(app.get('view'), Path.join(opts.root,view))
    //    console.log("foundview", view)
        if (foundView) break
      }
      return foundView
    }
 
    // Fallback to standard behavior, when root is a single directory
    return old.call(app.get('view'), options)
  }
 
  app.get('view').prototype.lookup = lookup;
}
