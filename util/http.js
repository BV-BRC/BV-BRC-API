const http = require('http')
const https = require('https')

module.exports = {
  'httpGet': async (options) => {
    return new Promise((resolve, reject) => {
      http.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on('error', (err) => {
          reject(err)
        })
      })
        .on('error', (err) => {
          reject(new Error(`Unable to request the database. ${err.code}`))
        })
    })
  },
    'requestUrlForUrl': (url) => {
	const parsed = new URL(url);
	return parsed.protocol === "http:" ? module.exports.httpRequestUrl : module.exports.httpsRequestUrl;
    },
	
  'httpRequest': async (options, body) => {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpsRequest': async (options, body) => {
	  console.log("POSTING", options, body);
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.on('error', (err) => {
        reject(new Error(`Unable to request the database. ${err.code}`))
      })
      req.write(body)
      req.end()
    })
  },
  'httpStreamRequest': async (options, streamableBody) => {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        reject(err)
      })
    })
  },
  'httpsStreamRequest': async (options, streamableBody) => {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      streamableBody.on('data', (chunk) => {
        req.write(chunk)
      })
      streamableBody.on('end', () => {
        req.end()
      })
      streamableBody.on('error', (err) => {
        reject(err)
      })
    })
  },
  'httpsGetUrl': async (url, options) => {
    return new Promise((resolve, reject) => {
      https.get(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on('error', (err) => {
          reject(err)
        })
      })
        .on('error', (err) => {
          reject(new Error(`Unable to request the database. ${err.code}`))
        })
    })
  },
  'httpsRequestUrl': async (url, options, body) => {
    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.write(body)
	req.end()
    })
  },
  'httpRequestUrl': async (url, options, body) => {
    return new Promise((resolve, reject) => {
      const req = http.request(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString()
        })
        res.on('end', () => {
          resolve(rawData)
        })
      })
        .on('error', (err) => {
          reject(err)
        })
      req.write(body)
      req.end()
    })
  }
}
