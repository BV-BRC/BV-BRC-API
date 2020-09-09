const assert = require('chai').assert
const Http = require('http')
const Config = require('../../config')
const Path = require('path')
const Fs = require('fs')
const Zlib = require('zlib')
const { PassThrough } = require('stream')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

async function httpGet (options) {
  return new Promise((resolve, reject) => {
    Http.get(options, (res) => {
      const finalStream = new PassThrough()
      let returnChunks
      let isFirst = true
      finalStream.on('data', (chunk) => {
        if (isFirst) {
          const lastIndex = chunk.lastIndexOf(Buffer.from('\0'))
          returnChunks = chunk.slice(lastIndex + 1).toString()
          isFirst = false
        } else {
          returnChunks += chunk.toString()
        }
      })
      finalStream.on('end', () => {
        resolve(returnChunks)
      })
      finalStream.on('error', (err) => {
        reject(err)
      })

      res.pipe(Zlib.createUnzip()).pipe(finalStream)
    })
      .on('error', (err) => {
        reject(err)
      })
  })
}

async function httpRequest (options, body) {
  return new Promise((resolve, reject) => {
    const req = Http.request(options, (res) => {
      const finalStream = new PassThrough()
      let returnChunks
      let isFirst = true
      finalStream.on('data', (chunk) => {
        if (isFirst) {
          const lastIndex = chunk.lastIndexOf(Buffer.from('\0'))
          returnChunks = chunk.slice(lastIndex + 1).toString()
          isFirst = false
        } else {
          returnChunks += chunk.toString()
        }
      })
      finalStream.on('end', () => {
        resolve(returnChunks)
      })

      res.pipe(Zlib.createUnzip()).pipe(finalStream)
    })
      .on('error', (err) => {
        reject(err)
      })
    req.write(body)
    req.end()
  })
}

const ExpectedFeaturesTab = Fs.readFileSync(Path.join(__dirname, '83332.12/83332.12.PATRIC.features.tab'), {
  encoding: 'utf8'
})

const ExpectedFaa = Fs.readFileSync(Path.join(__dirname, '83332.12/83332.12.PATRIC.faa'), {
  encoding: 'utf8'
})

const RequestOption = {
  port: Config.get('http_port'),
  agent: agent,
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  method: 'POST',
  path: '/bundle/genome/'
}

describe('Test Router - Download', function () {
  it('POST - Genome PATRIC.features.tab', async function () {
    return httpRequest(RequestOption, 'q=eq(genome_id,83332.12)&archiveType=tar&types=*PATRIC.features.tab')
      .then((body) => {
        const firstIndex = body.indexOf('\0')
        const trimmedBody = body.slice(0, firstIndex)
        assert.equal(trimmedBody, ExpectedFeaturesTab)
      })
  })

  it('POST - Genome PATRIC.faa', async function () {
    return httpRequest(RequestOption, 'q=eq(genome_id,83332.12)&archiveType=tar&types=*PATRIC.faa')
      .then((body) => {
        const firstIndex = body.indexOf('\0')
        const trimmedBody = body.slice(0, firstIndex)
        assert.equal(trimmedBody, ExpectedFaa)
      })
      .catch((err) => {
        console.error(`${err}`)
      })
  })

  it('GET - Genome PATRIC.features.tab', async function () {
    return httpGet(Object.assign(RequestOption, {
      method: 'GET',
      path: '/bundle/genome/?q=eq(genome_id,83332.12)&archiveType=tar&types=*PATRIC.features.tab'
    }))
      .then((body) => {
        const firstIndex = body.indexOf('\0')
        const trimmedBody = body.slice(0, firstIndex)
        assert.equal(trimmedBody, ExpectedFeaturesTab)
      })
  })

  it('GET - Genome PATRIC.faa', async function () {
    return httpGet(Object.assign(RequestOption, {
      method: 'GET',
      path: '/bundle/genome/?q=eq(genome_id,83332.12)&archiveType=tar&types=*PATRIC.faa'
    }))
      .then((body) => {
        const firstIndex = body.indexOf('\0')
        const trimmedBody = body.slice(0, firstIndex)
        assert.equal(trimmedBody, ExpectedFaa)
      })
      .catch((err) => {
        console.error(`${err}`)
      })
  })
})
