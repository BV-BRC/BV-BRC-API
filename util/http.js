const http = require('http')
const https = require('https')

module.exports = {
  'httpGet': async (options) => {
    return new Promise((resolve, reject) => {
      http.get(options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString();
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on("error", (err) => {
            reject(err)
        })
      })
    })
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
      req.write(body)
      req.end()
    })
  },
  'httpsGetUrl': async (url, options) => {
    return new Promise((resolve, reject) => {
      https.get(url, options, (res) => {
        res.setEncoding('utf8')
        let rawData = ''
        res.on('data', (chunk) => {
          rawData += chunk.toString();
        })
        res.on('end', () => {
          resolve(rawData)
        })
        res.on("error", (err) => {
            reject(err)
        })
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
  }
}