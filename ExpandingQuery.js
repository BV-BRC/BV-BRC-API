var debug = require('debug')('p3api-server:ExpandingQuery')
var when = require('promised-io/promise').when
var Deferred = require('promised-io/promise').defer
var All = require('promised-io/promise').all
// var Sequence = require("promised-io/promise").seq;
// var LazyArray = require("promised-io/lazy-array").LazyArray;
var Query = require('rql/query').Query
var request = require('request')
var config = require('./config')
var Request = require('request')
var distributeURL = config.get('distributeURL')

var workspaceAPI = config.get('workspaceAPI')

function getWorkspaceObject (id, opts) {
  var def = new Deferred()
  // debug("in getWorkspaceObject: ", id);
  // debug("wsAPI: ", workspaceAPI);
  // debug("opts req headers: ", opts.req.headers);
  Request({
    method: 'POST',
    url: workspaceAPI,
    json: true,
    body: {id: 1, method: 'Workspace.get', version: '1.1', params: [{objects: [decodeURIComponent(id)]}]},
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
    }
  }, function (err, resObj, results) {
    if (err) {
      debug('Error retrieving object from workspace: ', err)

      def.reject(err)
      return
    }
    if (results.result) {
      var R = []
      results.result[0].map(function (o) {
        var obj = (typeof o[1] == 'string') ? JSON.parse(o[1]) : o[1]
        // debug("obj: ", obj );
        // debug("obj id_list: ", obj.id_list);
        Object.keys(obj.id_list).forEach(function (key) {
          R = R.concat(obj.id_list[key].filter(function (y) {
            return !!y
          }))
        })
      })
      if (R.length < 1) {
        R.push('NOT_A_VALID_ID')
      }

      R = R.map(encodeURIComponent)
      // debug("R: ", R[0]);
      def.resolve(R)
      return
    }
    def.reject(false)
  })
  return def.promise
}

function runJoinQuery (core, query, field, opts) {
  var def = new Deferred()

  when(query, function (subquery) {
    var q = subquery + '&facet((field,' + field + '),(limit,-1),(mincount,1))&json(nl,map)&limit(1)'
    // debug("query: [", q, "]");

    Request.post({
      url: distributeURL + core + '/',
      json: true,
      headers: {
        'Accept': 'application/solr+json',
        'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
        'Authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
      },
      body: q
    }, function (err, resObj, results) {
      if (err) {
        def.reject(err)
        return
      }

      // debug("results: ", results);
      // debug(results['facet_counts']['facet_fields'][field]);
      if (results['facet_counts']['facet_fields'][field]) {
        var R = Object.keys(results['facet_counts']['facet_fields'][field])

        def.resolve(R)
        return
      }

      def.reject(false)
    })
  })
  return def.promise
}

function runSDISubQuery (core, query, opts) {
  const def = new Deferred()

  Request.get({
    url: distributeURL + core + '/?' + query + '&facet((field,feature_id_a),(field,feature_id_b),(limit,-1),(mincount,1))&json(nl,map)&limit(1)',
    json: true,
    headers: {
      'Accept': 'application/solr+json',
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      'Authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
    }
  }, function (err, resObj, results) {
    if (err) {
      def.reject(err)
    }

    if (results['facet_counts']['facet_fields']['feature_id_a'] && results['facet_counts']['facet_fields']['feature_id_b']) {
      var data = Object.assign({}, results['facet_counts']['facet_fields']['feature_id_a'], results['facet_counts']['facet_fields']['feature_id_b'])

      // debug("runSDISubQuery result: ", Object.keys(data).length);
      def.resolve(Object.keys(data))
    } else {
      def.resolve([])
    }
  })

  return def.promise
}

var LazyWalk = exports.LazyWalk = function (term, opts) {
// debug("LazyWalk term: ", term);
// debug("stringified term: ", Query(term).toString());
  var children

  if (term && (typeof term == 'string')) {
    // debug("TERM: ", term);
    return encodeURIComponent(term)
  }

  if (typeof term == 'boolean') {
    return term ? 'true' : 'false'
  }

  if ((term === 0) || (typeof term == 'number')) {
    return term.toString()
  }

  if (term && term instanceof Array) {
    var out = []
    var defs = term.map(function (t) {
      return when(LazyWalk(t, opts), function (t) {
        out.push(t)
      })
    })

    return when(All(defs), function (defs) {
      // debug("Out: ", out);
      return '(' + out.join(',') + ')'
    })
    // debug("LazyWalk term is instanceof Array: ", term);
    // debug("Return Val: (" + term.join(",") + ")");
    // return "(" + term.join(",") +")"
  }
  // debug("term: ", term, " type: ", typeof term, " args: ", term.args);
  if (term && typeof term == 'object') {
    if (term.name) {
      if (term.args) {
        term.args = term.args.map(function (t, index) {
          return LazyWalk(t, opts)
        })

        return when(All(term.args), function (args) {
          if (opts && opts.expansions && opts.expansions[term.name]) {
            var expanded = opts.expansions[term.name].apply(this, term.args)
            // debug("expanded: ", expanded);
            return when(ResolveQuery(expanded, opts, false), function (expanded) {
              debug('Expanded POST WALK: ' + expanded)
              return expanded
            })
          }
          if (term.name == 'and' && term.args.length == 1) {
            return term.args[0]
          } else if (term.name == 'and' && term.args.length == 0) {
            return ''
          } else if (term.name == 'join' && term.args.length == 3) {
            // args: core, query, field
            return when(runJoinQuery(term.args[0], term.args[1], term.args[2], opts), function (ids) {
              return 'in(' + term.args[2] + ',(' + ids.join(',') + '))'
            }, function (err) {
              debug('Error in sub query', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name == 'descendants') {
            // debug("call descendants(): ", term.args);
            var queries = []
            term.args.forEach(function (taxId) {
              var p1 = encodeURIComponent('(*,' + taxId + ')')
              var p2 = encodeURIComponent('(*,' + taxId + ',*)')
              queries.push('eq(taxid_a,' + taxId + ')')
              queries.push('eq(taxid_b,' + taxId + ')')
              queries.push('eq(taxpath_a,' + p1 + ')')
              queries.push('eq(taxpath_a,' + p2 + ')')
              queries.push('eq(taxpath_b,' + p1 + ')')
              queries.push('eq(taxpath_b,' + p2 + ')')
            })

            return 'or(' + queries.join(',') + ')'
          } else if (term.name == 'secondDegreeInteraction') {
            var featureId = term.args[0]

            var query = 'or(eq(feature_id_a,' + featureId + '),eq(feature_id_b,' + featureId + '))&select(feature_id_a,feature_id_b)'

            return when(runSDISubQuery('ppi', query), function (feature_ids) {
              // debug("feature_ids: ", feature_ids);
              if (feature_ids.length === 0) {
                return '(NOT_A_VALID_ID)'
              }

              return 'and(in(feature_id_a,(' + feature_ids.join(',') + ')),in(feature_id_b,(' + feature_ids.join(',') + ')),or(eq(feature_id_a,' + featureId + '),eq(feature_id_b,' + featureId + ')))'
            }, function (err) {
              debug('Error in 2ndDegree function call', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name == 'GenomeGroup') {
            // debug("call getWorkspaceObject(): ", term.args[0]);
            return when(getWorkspaceObject(term.args[0], opts), function (ids) {
              // debug("getWSObject: ", ids);
              var out = '(' + ids.join(',') + ')'
              // debug("out: ", out);
              return out
            }, function (err) {
              debug('Error Retrieving Workspace: ', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name == 'FeatureGroup') {
            // debug("call getWorkspaceObject(): ", term.args[0]);
            return when(getWorkspaceObject(term.args[0], opts), function (ids) {
              // debug("getWSObject: ", ids);
              var out = '(' + ids.join(',') + ')'
              // debug("out: ", out);
              return out
            }, function (err) {
              debug('Error Retrieving Workspace: ', err)
              return '(NOT_A_VALID_ID)'
              // return err
            })
          } else if (term.name == 'query') {
            var modelId = args[0]
            var q = Query(args[1])
            // debug("q: ", q);
            var query = q.toString()
            var type = 'public'
            // debug("typeof query: ", typeof query);
            // debug("Do Query ", modelId, query);
            if (opts && opts.req && opts.req.user) {
              if (opts.req.user.isAdmin) {
                type = 'admin'
              } else {
                type = 'user'
              }
            }

            // debug(" get executor for  modelId: ", modelId, "type: ", type);
            var queryFn = DME.getModelExecutor('query', modelId, type)
            if (!queryFn) {
              throw new Error('Invalid Executor during LazyWalk for Query Resolver')
            }
            return when(runQuery(queryFn, query, opts), function (results) {
              // debug("runQuery results len: ",results?results.length:"None");

              // debug('results: ', results);
              if (results instanceof Array) {
                // debug("instance of array", results);
                return '(' + results.join(',') + ')'
              } else {
                // debug("non-array", results);
                return results
              }
            }, function (err) {
              // debug("SubQuery Error: ", err);
            })
          }
          // debug("Fall through: ", term, args);
          return term.name + '(' + args.join(',') + ')'
        }, function (err) {
          throw Error('Error Lazily Expanding Query: ' + err)
        })
      } else {
        return term.name + '()'
      }
    } else if (term.args) {
      return '(' + term.args.join(',') + ')'
    }
  }
  debug('Skipping Invalid Term: ', term)
  // throw Error("Invalid Term - " + JSON.stringify(term));
}

var queryCache = {}

function runQuery (queryFn, query, opts) {
  // debug("Launch Query : ",query);
  if (opts && opts.req) {
    if (opts.req.queryCache && opts.req.queryCache[query]) {
      return opts.req.queryCache[query]
    }
  }
  return when(queryFn(query, opts), function (qres) {
    if (opts && opts.req) {
      if (!opts.req.queryCache) {
        opts.req.queryCache = {}
      }
      opts.req.queryCache[query] = qres
    }
    // debug("qres len: ", qres.length);
    return qres
  })
}

var ResolveQuery = exports.ResolveQuery = function (query, opts, clearCache) {
  // normalize to object with RQL's parser
  // debug("ResolveQuery: ", query);

  if (typeof query == 'string') {
    query = Query(query)
  }

  // walk the parsed query and lazily resolve any subqueries/joins
  return when(LazyWalk(query, opts), function (finalQuery) {
    // finalQuery will be a new string query
    // debug("Final Query: " + finalQuery);
    if (opts && opts.req.queryCache && clearCache) {
      delete opts.req.queryCache
    }
    return finalQuery
  })
}

var Walk = exports.Walk = function (term, expansions) {
  if (!term) {
    return ''
  }
  // debug("stringified term: ", Query(term).toString());
  var children

  if (term && (typeof term == 'string')) {
    return encodeURIComponent(term)
    // return term;
  }

  if (term && (typeof term == 'number')) {
    return term.toString()
  }

  if (term && term instanceof Array) {
    // debug("Term is an array: ", term);
    return '(' + term.join(',') + ')'
  }

  if (term && typeof term == 'object') {
    // debug("Term is object: ", term);
    if (term.name) {
      if (term.args && (term.args.length > 0)) {
        term.args = term.args.map(function (t, index) {
          // debug("Walk SubTerm: ", t, " Expansions: ", expansions);
          return Walk(t, expansions)
        })

        return when(All(term.args), function (args) {
          // debug("term.args resolved: ", args);
          if (term.name && expansions[term.name]) {
            if (typeof expansions[term.name] == 'function') {
              return expansions[term.name].apply(args)
            }
          }
          return term.name + '(' + args.join(',') + ')'
        })
      } else {
        return term.name + '()'
      }
    }
  }
  throw Error('Invalid Term - ' + JSON.stringify(term))
}

exports.ExpandQuery = function (query, expansions) {
  expansions = expansions || _expansions || {}
  // normalize to object with RQL's parser
  // debug("ResolveQuery: ", query);

  if (typeof query == 'string') {
    query = Query(query)
  }
  // debug("Query: ", query);
  // walk the parsed query and lazily resolve any subqueries/joins
  return when(Walk(query, expansions), function (finalQuery) {
    // finalQuery will be a new string query
    // debug("Expanded Query: ", finalQuery);
    return finalQuery
  })
}
