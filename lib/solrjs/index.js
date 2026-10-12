const debug = require('debug')('solrjs')
const { userAgent } = require('../userAgent')
const { solrHttpError } = require('../solrHttpError')
const EventEmitter = require('events').EventEmitter
const declare = require('dojo-declare/declare')
const Readable = require('event-stream').readable
const Http = require('http')
const Https = require('https')
const URL = require('url').URL
const limitRe = /(&rows=)(\d*)/

function getMethodAndAuthFromURL(url, agent) {
    const parsedUrl = new URL(url)

    const obj = parsedUrl.protocol === "http:" ? Http : Https;
    const auth = parsedUrl.password ? `${parsedUrl.username}:${parsedUrl.password}` : '';
    //    debug(`have obj with proto ${obj.globalAgent.protocol}`);
    const ret = {
	auth: auth,
	protocol: parsedUrl.protocol
    }
    if (agent) {
	ret.agent = agent;
    }

    // debug(`returning ${JSON.stringify([obj, ret],undefined,2)}`)
    return [obj, ret];
}

// Arm an inactivity timeout on an outbound Solr request.
//
// Without this, a connection that is accepted but never answered — classically a
// pooled keepAlive socket the far side has already dropped, which leaves no FIN —
// hangs until the OS tears down the TCP connection. Measured at ~166s in the
// GenBank investigation (Docs/GENBANK_DOWNLOAD_PERFORMANCE.md); long enough that
// Cloudflare's 100s origin limit fires first and the user sees a 524.
//
// A stale socket cannot be detected before use: TCP offers no liveness check
// without sending data. This timer *is* the detection mechanism.
//
// No-ops when timeoutMs is falsy (0 or undefined), so callers that have not
// opted in behave exactly as before.
//
// req.destroy(err) emits 'error' on the request; every caller here already has a
// req.on('error') handler that rejects, so the timeout surfaces as a normal
// rejection rather than needing its own reject path.
function armTimeout (req, timeoutMs) {
  if (!timeoutMs) {
    return
  }
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error(`Solr request timed out after ${timeoutMs}ms`))
  })
}

function subQuery (reqObj, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = reqObj.request(options, (res) => {
      let rawData = ''
      res.on('data', (chunk) => {
        rawData += chunk.toString()
      })
      res.on('end', () => {
        // Only overload statuses are turned into rejections here. Solr reports ordinary
        // query errors in a JSON body (often with a 4xx), and middleware/APIMethodHandler
        // inspects `results.error` to produce its own 400 — rejecting every non-2xx would
        // reroute that into the generic error handler and change existing behavior. 429
        // and 503 are different: there is no useful body, and the caller needs the status
        // to avoid hammering a node that is shedding load. See lib/solrHttpError.js.
        if (res.statusCode === 429 || res.statusCode === 503) {
          reject(solrHttpError(res, rawData))
          return
        }
        try {
          resolve(JSON.parse(rawData))
        } catch {
          reject(new Error(`Unable to parse the stream response.`))
        }
      })
      res.on('error', (err) => {
        reject(new Error(`Unable to receive a response. ${err}`))
      })
    })
    armTimeout(req, timeoutMs)
    req.on('error', (err) => {
      reject(new Error(`Unable to request the database. ${err}`))
    })
    req.write(body)
    req.end()
  })
}

module.exports = declare([EventEmitter], {
  constructor: function (url, options) {
    debug('Instantiate SOLRjs Client at ' + url)
    this.url = url
    this.options = options
    this.agent = undefined
  },

  setAgent: function (agent) {
    this.agent = agent
  },

  setHeaders: function (headers) {
    this.customHeaders = headers
  },
  streamChunkSize: 2000,
  maxStreamSize: 250000,
  _streamQuery: function (query, stream, callback, currentCount, totalReqLimit, cursorMark) {
    debug(`_streamQuery currentCount: ${currentCount} total: ${totalReqLimit}`)
    if (!cursorMark) {
      cursorMark = '*'
    }

    const rowsMatch = query.match(limitRe)

    if (totalReqLimit > rowsMatch) {
      query = query.replace(limitRe, `&rows=${this.streamChunkSize}`)
    }

    const _self = this
    const qbody = `${query}&start=0&wt=json&cursorMark=${cursorMark}`

    debug(`Stream call: ${qbody}`)

      const parsedUrl = new URL(this.url)
      const [reqObj, reqOpts] = getMethodAndAuthFromURL(this.url, this.agent)
      
      subQuery(
	  reqObj,
	  {
	      ...reqOpts,
	      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent(),
          ...this.customHeaders
      },
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}/select`
    }, qbody, this.timeout).then((data) => {
	    //console.log("RAW " + JSON.stringify(data, 0, 2));
      if (cursorMark === '*') {
        const header = { response: {} }
        if (data.responseHeader) {
          header.responseHeader = data.responseHeader
        }

        if (data.response) {
          Object.keys(data.response).forEach((key) => {
            if (key === 'docs') {
              return
            }
            header.response[key] = data.response[key]
          })

          stream.emit('data', header)
        } else {
          debug('No Response Body')
          stream.emit('end')
          callback()
          return
        }
      }

      if (data.response && (data.response.numFound < totalReqLimit)) {
        totalReqLimit = data.response.numFound
      }

      if (data.nextCursorMark) {
        debug('Got Next CursorMark: ', data.nextCursorMark)
        if (data.response.docs) {
          data.response.docs.forEach((doc) => {
            // debug('PUSH DATA INTO STREAM: ', doc)
            if (currentCount++ < totalReqLimit) {
              stream.emit('data', doc)
            }
          })
          debug('More than total?', currentCount < totalReqLimit)
          if (currentCount < totalReqLimit) {
            _self._streamQuery(query, stream, callback, currentCount, totalReqLimit, data.nextCursorMark)
          } else {
            debug('END STREAM')
            stream.emit('end')
            callback()
          }
        } else {
          debug('NO DOCS: ', data)
          stream.emit('end')
          callback()
        }
      } else {
        debug('No Next CursorMark')
        if (data.response.docs) {
          data.response.docs.forEach((doc) => {
            // debug('PUSH DATA INTO STREAM: ', doc)
            stream.emit('data', doc)
          })
          stream.emit('end')
          callback()
        } else {
          debug('NO DOCS: ', data)
          stream.emit('end')
          callback()
        }
      }
    }, (err) => {
      console.error(`Unable to complete stream query: ${err}`)
      stream.emit('end')
      callback()
    })
  },

  stream: function (query, options) {
    return new Promise((resolve, reject) => {
      var _self = this
      var limitMatch = query.match(limitRe)
      var totalReqLimit = this.maxStreamSize

      if (limitMatch) {
        totalReqLimit = limitMatch[2]
      }

      const es = new Readable(function (count, callback) {
        _self._streamQuery(query, this, callback, 0, totalReqLimit)
      })

      resolve({ stream: es })
    })
  },

  query: function (query, options) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(this.url)
      const qbody = `${query}&wt=json`
      debug(`Query call: ${qbody} `)
      // debug(`${parsedUrl.host}/${parsedUrl.path}/select?${qbody}`)

	const [reqObj, reqOpts] = getMethodAndAuthFromURL(this.url, this.agent)

	// console.log(`${reqObj.globalAgent.protocol} and ${JSON.stringify(reqOpts)}`);
	const req = reqObj.request({
	    ...reqOpts,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent(),
          ...this.customHeaders
        },
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}/select`
      }, (res) => {
        let rawResponseData = ''
        // res.on('data', (chunk) => {
        //   rawResponseData += chunk.toString()
        // })
        res.on('readable', () => {
          let chunk
          while ((chunk = res.read()) !== null) {
            rawResponseData += chunk
          }
        })
        res.on('end', () => {
          // Overload statuses reject with the code intact; see the matching comment in
          // subQuery(). Other non-2xx responses keep resolving with their parsed body so
          // middleware/APIMethodHandler's `results.error` handling is unchanged.
          if (res.statusCode === 429 || res.statusCode === 503) {
            reject(solrHttpError(res, rawResponseData))
            return
          }
          try {
            const parsed = JSON.parse(rawResponseData)
            resolve(parsed)
          } catch {
            reject(new Error(`Unable to parse the query response. ${rawResponseData}`))
          }
        })
        res.on('error', (err) => {
          reject(new Error(`Unable to receive a response. ${err}`))
        })
      })
      // Per-call `options.timeout` overrides the client-level `this.timeout`.
      armTimeout(req, (options && options.timeout) || this.timeout)
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err}`))
      })
      req.write(qbody)
      req.end()
    })
  },

  get: function (id) {
    return new Promise((resolve, reject) => {
      let prop = 'id'
      if ((id instanceof Array) && (id.length > 0)) {
        if (id.length === 1) {
          id = encodeURIComponent(id[0])
        } else {
          prop = 'ids'
          id = id.map((i) => {
            return encodeURIComponent(i)
          }).join(',')
        }
      } else {
        id = encodeURIComponent(id)
      }

      const [reqObj, reqOpts] = getMethodAndAuthFromURL(this.url, this.agent)

      debug(`GET call: ${this.url}/get?${prop}=${id}`)
      const req = reqObj.get(`${this.url}/get?${prop}=${id}`, {
          headers: {
          accept: 'application/json',
          'User-Agent': userAgent(),
          ...this.customHeaders
        },
	  ...reqOpts,

      }, (res) => {
        let rawResponseData = ''
        res.on('data', (chunk) => {
          rawResponseData += chunk.toString()
        })
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode === 503) {
            reject(solrHttpError(res, rawResponseData))
            return
          }
          try {
            const parsed = JSON.parse(rawResponseData)
            resolve(parsed)
          } catch {
            reject(new Error(`Unable to parse the get response. ${rawResponseData}`))
          }
        })
        res.on('error', (err) => {
          reject(new Error(`Unable to receive a response. ${err}`))
        })
      })
      armTimeout(req, this.timeout)
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err}`))
      })
    })
  },

  getSchema: function () {
    return new Promise((resolve, reject) => {
      debug(`Schema call: ${this.url}/schema`)
      const req = Http.get(`${this.url}/schema`, {
        headers: {
          accept: 'application/json'
        },
        agent: this.agent
      }, (res) => {
        let rawResponseData = ''
        res.on('data', (chunk) => {
          rawResponseData += chunk.toString()
        })
        res.on('end', () => {
          if (res.statusCode === 429 || res.statusCode === 503) {
            reject(solrHttpError(res, rawResponseData))
            return
          }
          try {
            const parsed = JSON.parse(rawResponseData)
            resolve(parsed)
          } catch {
            reject(new Error(`Unable to parse the schema response. ${rawResponseData}`))
          }
        })
        res.on('error', (err) => {
          reject(new Error(`Unable to receive a response. ${err}`))
        })
      })
      armTimeout(req, this.timeout)
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err}`))
      })
    })
  }
})
