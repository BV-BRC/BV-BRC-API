const debug = require('debug')('solrjs')
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

function subQuery (reqObj, options, body) {
  return new Promise((resolve, reject) => {
    const req = reqObj.request(options, (res) => {
      let rawData = ''
      res.on('data', (chunk) => {
        rawData += chunk.toString()
      })
      res.on('end', () => {
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
        ...this.customHeaders
      },
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}/select`
    }, qbody).then((data) => {
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
          ...this.customHeaders
        },
	  ...reqOpts,

      }, (res) => {
        let rawResponseData = ''
        res.on('data', (chunk) => {
          rawResponseData += chunk.toString()
        })
        res.on('end', () => {
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
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err}`))
      })
    })
  }
})
