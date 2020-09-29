const debug = require('debug')('p3api-server:ExpandingQuery')
const Query = require('rql/query').Query
const Config = require('./config')
const { httpRequest, httpGet, httpsRequestUrl } = require('./util/http')

const WORKSPACE_API_URL = Config.get('workspaceAPI')

function getWorkspaceObject (id, opts) {
  return new Promise((resolve, reject) => {
    debug('in getWorkspaceObject: ', id)
    httpsRequestUrl(WORKSPACE_API_URL, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
      },
      method: 'POST'
    }, JSON.stringify({
      id: 1, method: 'Workspace.get', version: '1.1', params: [{ objects: [decodeURIComponent(id)] }]
    })).then((body) => {
      const results = JSON.parse(body)
      if (results.result) {
        let R = []
        try {
          results.result[0].map(function (o) {
            const obj = (typeof o[1] === 'string') ? JSON.parse(o[1]) : o[1]
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
          resolve(R)
        } catch (err) {
          console.error(`ExpandingQuery::getWorkspaceObject() ${err} id: ${id}, results:`, results)
          reject(new Error(`Unable to process workspace object. ${err}`))
        }
      } else {
        reject(new Error(`Unable to parse workspace query result`))
      }
    }, (err) => {
      reject(err)
    })
  })
}

function runJoinQuery (core, query, field, opts) {
  return new Promise((resolve, reject) => {
    debug('*** runJoinQuery:', core, query, field)
    query.then((subquery) =>
      httpRequest({
        headers: {
          'Accept': 'application/solr+json',
          'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
          'Authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
        },
        method: 'POST',
        port: Config.get('http_port'),
        path: `/${core}/`
      }, `${subquery}&facet((field,${field}),(limit,-1),(mincount,1))&json(nl,map)&limit(1)`)
        .then((results) => {
          const data = JSON.parse(results)
          if (data['facet_counts']['facet_fields'][field]) {
            resolve(Object.keys(data['facet_counts']['facet_fields'][field]))
          }
        }, (err) => {
          reject(new Error(`Unable to execute sub query: ${err}`))
        })
      , (err) => {
      reject(new Error(`Unable to resolve query: ${err}`))
    })
  })
}

function runSDISubQuery (core, query, opts) {
  debug('**** runSDISubQuery:')
  return httpGet({
    port: Config.get('http_port'),
    headers: {
      'Accept': 'application/solr+json',
      'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
      'Authorization': (opts && opts.req && opts.req.headers['authorization']) ? opts.req.headers['authorization'] : ''
    },
    path: `/${core}/?${query}&facet((field,feature_id_a),(field,feature_id_b),(limit,-1),(mincount,1))&json(nl,map)&limit(1)`
  }).then((res) => {
    const results = JSON.parse(res)
    if (results['facet_counts']['facet_fields']['feature_id_a'] && results['facet_counts']['facet_fields']['feature_id_b']) {
      const data = Object.assign({}, results['facet_counts']['facet_fields']['feature_id_a'], results['facet_counts']['facet_fields']['feature_id_b'])

      return Object.keys(data)
    } else {
      return []
    }
  })
}

var LazyWalk = exports.LazyWalk = function (term, opts) {
// debug('LazyWalk term: ', term);
// debug('stringified term: ', Query(term).toString());

  if (term && (typeof term === 'string')) {
    // debug('TERM: ', term);
    return encodeURIComponent(term)
  }

  if (typeof term === 'boolean') {
    return term ? 'true' : 'false'
  }

  if ((term === 0) || (typeof term === 'number')) {
    return term.toString()
  }

  if (term && term instanceof Array) {
    var out = []
    var defs = term.map(function (t) {
      return Promise.all([LazyWalk(t, opts)]).then((vals) => {
        out.push(vals[0])
      })
    })

    return Promise.all(defs).then(function (defs) {
      // debug('Out: ', out);
      return '(' + out.join(',') + ')'
    })
    // debug('LazyWalk term is instanceof Array: ', term);
    // debug('Return Val: (' + term.join(',') + ')');
    // return '(' + term.join(',') +')'
  }
  // debug('term: ', term, ' type: ', typeof term, ' args: ', term.args);
  if (term && typeof term === 'object') {
    if (term.name) {
      if (term.args) {
        term.args = term.args.map(function (t, index) {
          return LazyWalk(t, opts)
        })

        return Promise.all(term.args).then(function (args) {
          if (opts && opts.expansions && opts.expansions[term.name]) {
            var expanded = opts.expansions[term.name].apply(this, term.args)
            // debug('expanded: ', expanded);
            return ResolveQuery(expanded, opts, false).then(function (expanded) {
              debug('Expanded POST WALK: ' + expanded)
              return expanded
            })
          }
          if (term.name === 'and' && term.args.length === 1) {
            return term.args[0]
          } else if (term.name === 'and' && term.args.length === 0) {
            return ''
          } else if (term.name === 'join' && term.args.length === 3) {
            // args: core, query, field
            return runJoinQuery(term.args[0], term.args[1], term.args[2], opts).then(function (ids) {
              return 'in(' + term.args[2] + ',(' + ids.join(',') + '))'
            }, function (err) {
              debug('Error in sub query', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name === 'descendants') {
            // debug('call descendants(): ', term.args);
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
          } else if (term.name === 'secondDegreeInteraction') {
            var featureId = term.args[0]

            var query = 'or(eq(feature_id_a,' + featureId + '),eq(feature_id_b,' + featureId + '))&select(feature_id_a,feature_id_b)'

            return runSDISubQuery('ppi', query).then(function (feature_ids) {
              // debug('feature_ids: ', feature_ids);
              if (feature_ids.length === 0) {
                return '(NOT_A_VALID_ID)'
              }

              return 'and(in(feature_id_a,(' + feature_ids.join(',') + ')),in(feature_id_b,(' + feature_ids.join(',') + ')),or(eq(feature_id_a,' + featureId + '),eq(feature_id_b,' + featureId + ')))'
            }, function (err) {
              debug('Error in 2ndDegree function call', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name === 'GenomeGroup') {
            // debug('call getWorkspaceObject(): ', term.args[0]);
            return getWorkspaceObject(term.args[0], opts).then(function (ids) {
              // debug('getWSObject: ', ids);
              var out = '(' + ids.join(',') + ')'
              // debug('out: ', out);
              return out
            }, function (err) {
              debug('Error Retrieving Workspace: ', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name === 'FeatureGroup') {
            // debug('call getWorkspaceObject(): ', term.args[0]);
            return getWorkspaceObject(term.args[0], opts).then(function (ids) {
              // debug('getWSObject: ', ids);
              var out = '(' + ids.join(',') + ')'
              // debug('out: ', out);
              return out
            }, function (err) {
              debug('Error Retrieving Workspace: ', err)
              return '(NOT_A_VALID_ID)'
            })
          } else if (term.name === 'query') {
            var modelId = args[0]
            var q = Query(args[1])
            // debug('q: ', q);
            const query = q.toString()
            var type = 'public'
            // debug('typeof query: ', typeof query);
            // debug('Do Query ', modelId, query);
            if (opts && opts.req && opts.req.user) {
              if (opts.req.user.isAdmin) {
                type = 'admin'
              } else {
                type = 'user'
              }
            }

            // debug(' get executor for  modelId: ', modelId, 'type: ', type);
            var queryFn = DME.getModelExecutor('query', modelId, type)
            if (!queryFn) {
              throw new Error('Invalid Executor during LazyWalk for Query Resolver')
            }
            return runQuery(queryFn, query, opts).then(function (results) {
              // debug('runQuery results len: ',results?results.length:'None');

              // debug('results: ', results);
              if (results instanceof Array) {
                // debug('instance of array', results);
                return '(' + results.join(',') + ')'
              } else {
                // debug('non-array', results);
                return results
              }
            }, function (err) {
              // debug('SubQuery Error: ', err)
              throw Error('Error Expanding Query: ' + err)
            })
          }
          // debug('Fall through: ', term, args);
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
}

function runQuery (queryFn, query, opts) {
  if (opts && opts.req) {
    if (opts.req.queryCache && opts.req.queryCache[query]) {
      return opts.req.queryCache[query]
    }
  }
  return queryFn(query, opts).then(function (qres) {
    if (opts && opts.req) {
      if (!opts.req.queryCache) {
        opts.req.queryCache = {}
      }
      opts.req.queryCache[query] = qres
    }
    return qres
  })
}

var ResolveQuery = exports.ResolveQuery = function (query, opts, clearCache) {
  // normalize to object with RQL's parser
  // debug('ResolveQuery: ', query);

  if (typeof query === 'string') {
    query = Query(query)
  }

  // walk the parsed query and lazily resolve any subqueries/joins
  return Promise.all([LazyWalk(query, opts)]).then((vals) => {
    const finalQuery = vals[0]
    // finalQuery will be a new string query
    // debug('Final Query: ' + finalQuery);
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
  // debug('stringified term: ', Query(term).toString());

  if (term && (typeof term === 'string')) {
    return encodeURIComponent(term)
  }

  if (term && (typeof term === 'number')) {
    return term.toString()
  }

  if (term && term instanceof Array) {
    // debug('Term is an array: ', term);
    return '(' + term.join(',') + ')'
  }

  if (term && typeof term === 'object') {
    // debug('Term is object: ', term);
    if (term.name) {
      if (term.args && (term.args.length > 0)) {
        term.args = term.args.map(function (t, index) {
          // debug('Walk SubTerm: ', t, ' Expansions: ', expansions);
          return Walk(t, expansions)
        })

        return Promise.all(term.args).then(function (args) {
          // debug('term.args resolved: ', args);
          if (term.name && expansions[term.name]) {
            if (typeof expansions[term.name] === 'function') {
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
  // debug('ResolveQuery: ', query);

  if (typeof query === 'string') {
    query = Query(query)
  }
  // debug('Query: ', query);
  // walk the parsed query and lazily resolve any subqueries/joins
  return Promise.all([Walk(query, expansions)]).then((vals) => vals[0])
}
