const debug = require('debug')('p3api-server:ExpandingQuery')
const Query = require('rql/query').Query
const Config = require('./config')
const { httpsRequestUrl } = require('./util/http')
const { internalQuery } = require('./lib/internalQuery')

const WORKSPACE_API_URL = Config.get('workspaceAPI')

// RQLQueryParser.js caps a non-download query at 25000 rows during RQL→Solr conversion,
// and that is the cap the sub-queries here have always run under, because they *were*
// requests through that middleware. internalQuery's own default is MAX_LIMIT (50000), so
// this has to be passed explicitly or the ceiling silently doubles.
const MAX_REQUEST_LIMIT = 25000

/**
 * Read the calling request off `opts` without assuming its shape.
 *
 * The old code wrote `opts && opts.req && opts.req.headers['authorization']`, which guards
 * `opts.req` but NOT `opts.req.headers`. middleware/CrossCollectionSource.js calls
 * `ResolveQuery(cleaned, { req: {}, res: {} })`, so a cross-collection download whose
 * source filter contained join(), GenomeGroup() or FeatureGroup() threw a TypeError right
 * here — inside a promise nobody was watching, which is the hang-then-abort chain
 * described below. Verified before the fix; the same call now passes the real request.
 */
function reqOf (opts) {
  return (opts && opts.req) || {}
}

function authorizationOf (opts) {
  const headers = reqOf(opts).headers
  return (headers && headers['authorization']) || ''
}

/**
 * The identity a sub-query should run as.
 *
 * The self-calls these replaced forwarded the caller's Authorization header and let the
 * inner request's auth middleware re-validate it into `req.user`. Reading `req.user`
 * directly is the same identity without the second token validation.
 */
function userOf (opts) {
  return reqOf(opts).user
}

function requestIdOf (opts) {
  return reqOf(opts).requestId
}

async function getWorkspaceObject (id, opts) {
  debug('in getWorkspaceObject: ', id)
  const body = await httpsRequestUrl(WORKSPACE_API_URL, {
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': authorizationOf(opts)
    },
    method: 'POST'
  }, JSON.stringify({
    id: 1, method: 'Workspace.get', version: '1.1', params: [{ objects: [decodeURIComponent(id)] }]
  }))

  // The Workspace API answers a denied or missing object with a non-JSON body, and this
  // parse used to sit in a `.then` success handler whose sibling error handler could not
  // catch it (the two-argument form does not catch throws from inside the success half).
  // The rejection went unhandled and the enclosing `new Promise` never settled.
  let results
  try {
    results = JSON.parse(body)
  } catch (err) {
    throw new Error(`Unable to parse workspace query result. ${err}`)
  }

  if (!results.result) {
    throw new Error(`Unable to parse workspace query result`)
  }

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
  } catch (err) {
    console.error(`ExpandingQuery::getWorkspaceObject() ${err} id: ${id}, results:`, results)
    throw new Error(`Unable to process workspace object. ${err}`)
  }

  if (R.length < 1) {
    R.push('NOT_A_VALID_ID')
  }

  return R.map(encodeURIComponent)
}

/**
 * Resolve an RQL `join(core, subquery, field)` term to the list of `field` values matching
 * the sub-query, by faceting `core` on that field.
 *
 * WHY THIS NO LONGER SPEAKS HTTP
 * ------------------------------
 * This used to POST to the API's own listening port, from inside RQLQueryParser — a
 * self-call nested in the outer request's own middleware chain, and recursive for nested
 * join() terms. Over a 36h production window the self-calls as a group were the top client
 * by a factor of three (33,101 requests, 33% of traffic, 615,681s cumulative), and this
 * particular one is the resource-loop case: the outer request holds a slot in the same
 * worker pool the sub-query needs. See PLAN_ELIMINATE_SELF_CALL.md.
 *
 * IT WAS ALSO KILLING WORKERS
 * ---------------------------
 * util/http.js's httpRequest discards res.statusCode and resolves the body regardless, so
 * an inner 400 arrived here looking like a result. `JSON.parse` then either threw
 * (plain-text error body) or succeeded onto an object with no facet_counts, and the very
 * next line dereferenced `data['facet_counts']['facet_fields']`. Both are throws inside a
 * `.then(ok, fail)` success handler, which `fail` does not catch, so:
 *
 *   unhandled rejection -> --unhandled-rejections=strict -> uncaughtException
 *   -> swallowed by app.js:34 -> next() never called -> request hangs holding a worker slot
 *   -> async_hooks state corrupt -> the NEXT Solr-backed request aborts the process with
 *      "node::AsyncHooks::push_async_context ... Assertion failed: (trigger_async_id) >= (-1)"
 *
 * Reproduced 3/3 against the dev server, each from ONE unauthenticated request, with the
 * abort landing on `ExpandingQuery.js:68` in the log. All three triggers are ordinary
 * client mistakes rather than crafted attacks: a join on a field that does not exist, a
 * join against a collection that does not exist, and a join whose value smuggles a Solr
 * parameter (the sanitizer correctly returned 400 — and the 400 is what crashed us).
 *
 * Also gone: the `if` at :68 with no `else`, which never resolved the promise when the
 * facet came back without the requested field.
 */
async function runJoinQuery (core, query, field, opts) {
  debug('*** runJoinQuery:', core, query, field)

  let subquery
  try {
    subquery = await query
  } catch (err) {
    throw new Error(`Unable to resolve query: ${err}`)
  }

  let results
  try {
    results = await internalQuery({
      // `core` is client-supplied — it is the first argument of the RQL join() term. The
      // HTTP path gated it at app.js:187 via app.param('dataType'); internalQuery's
      // assertKnownCollection reinstates that, so a join still cannot name an arbitrary
      // Solr core.
      collection: core,
      query: `${subquery}&facet((field,${field}),(limit,-1),(mincount,1))&json(nl,map)&limit(1)`,
      // Same rows the caller would see querying `core` directly, which is what forwarding
      // the Authorization header achieved before.
      user: userOf(opts),
      maxLimit: MAX_REQUEST_LIMIT,
      requestId: requestIdOf(opts)
    })
  } catch (err) {
    throw new Error(`Unable to execute sub query: ${err.message}`)
  }

  const facetFields = results && results.facet_counts && results.facet_counts.facet_fields
  if (!facetFields) {
    // A 200 with no facets means the response was not the shape this code understands.
    // Throwing hands it to the caller's error branch below, which degrades the term to
    // (NOT_A_VALID_ID); the old code fell off the end of the promise instead.
    throw new Error(`Sub query on ${core} returned no facet counts`)
  }

  // A sub-query that matched nothing yields an empty facet map, not a missing one, so this
  // returns [] and the caller emits `in(field,())` — which the RQL parser rejects with
  // "Query Syntax Error: in(genome_id,())". That is the pre-conversion behavior, verified
  // against the dev server; it is a poor error message but it is an answer, not a hang.
  return Object.keys(facetFields[field] || {})
}

/**
 * Resolve `secondDegreeInteraction(featureId)` to the set of feature ids one hop away.
 *
 * ANONYMOUS ON PURPOSE. The old code read an Authorization header off `opts`, but the only
 * call site passes no `opts` at all, so this has always run unauthenticated. `ppi` is in
 * PublicDataTypes' publicFree list, so no permission filter applies either way and the
 * distinction is currently moot — but it is preserved deliberately rather than quietly
 * upgraded, because granting a query an identity it never had is not a transport change.
 */
async function runSDISubQuery (core, query, opts) {
  debug('**** runSDISubQuery:')
  const results = await internalQuery({
    collection: core,
    query: `${query}&facet((field,feature_id_a),(field,feature_id_b),(limit,-1),(mincount,1))&json(nl,map)&limit(1)`,
    user: undefined,
    maxLimit: MAX_REQUEST_LIMIT,
    requestId: requestIdOf(opts)
  })

  const facetFields = results && results.facet_counts && results.facet_counts.facet_fields
  if (!facetFields || !facetFields['feature_id_a'] || !facetFields['feature_id_b']) {
    return []
  }

  return Object.keys(Object.assign({}, facetFields['feature_id_a'], facetFields['feature_id_b']))
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
            //
            // A failed join propagates instead of degrading to (NOT_A_VALID_ID).
            //
            // The old handler here turned any sub-query failure into a term matching
            // nothing, i.e. HTTP 200 with zero rows — the "200 with wrong data" failure
            // mode this codebase warns about everywhere. It is worth being explicit that
            // this is not the behavior being taken away, because it was never reachable:
            // every error the sub-query could produce arrived as a resolved promise
            // carrying an error body (httpRequest discards res.statusCode), so the
            // handler above threw before this branch ran and the request hung instead.
            // Verified 3/3 against the dev server for a bad field, an unknown collection,
            // and a smuggled Solr parameter.
            //
            // So there is no working behavior to preserve, and the choice is between
            // silently-empty and an error. RQLQueryParser.js:133 already catches this and
            // answers 400 with a sanitized message, which is what /data now does too.
            // Note the status is 400 even when the cause is a Solr outage — that is
            // pre-existing for every resolution failure, not new here.
            //
            // GenomeGroup()/FeatureGroup() below keep their (NOT_A_VALID_ID) degradation:
            // unlike this one it IS reachable and observed (a workspace the caller cannot
            // read yields numFound=0 today), so changing it would be a real regression.
            return runJoinQuery(term.args[0], term.args[1], term.args[2], opts).then(function (ids) {
              return 'in(' + term.args[2] + ',(' + ids.join(',') + '))'
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

            // `opts` is passed only so the sub-query carries the caller's request id into
            // the Solr log. runSDISubQuery pins the identity to anonymous itself — see
            // the note on that function.
            return runSDISubQuery('ppi', query, opts).then(function (feature_ids) {
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
  expansions = expansions || {}
  // normalize to object with RQL's parser
  // debug('ResolveQuery: ', query);

  if (typeof query === 'string') {
    query = Query(query)
  }
  // debug('Query: ', query);
  // walk the parsed query and lazily resolve any subqueries/joins
  return Promise.all([Walk(query, expansions)]).then((vals) => vals[0])
}
