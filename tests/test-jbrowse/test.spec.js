const assert = require('chai').assert
const http = require('http')
const {httpGet} = require('../../util/http')
const Path = require('path')
const fs = require('fs')
const config = require('../../config')

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const rqlRequestOptions = {
  port: config.get('http_port'),
  agent: agent,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
  }
}

describe('Test Router - JBrowse', () => {

  const ExpectedTrackList = fs.readFileSync(Path.join(__dirname, 'expected.trackList.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/trackList', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/trackList'
        }))
        assert.equal(body, ExpectedTrackList)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  const ExpectedTracks = fs.readFileSync(Path.join(__dirname, 'expected.tracks.json'), {
    encoding: 'utf8'
  })
  it('GET /genome/:id/tracks', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/tracks'
        }))
        assert.equal(body, ExpectedTracks)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
  
  const ExpectedStatsGlobal = fs.readFileSync(Path.join(__dirname, 'expected.StatsGlobal.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/stats/global', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/stats/global'
        }))
        assert.equal(body, ExpectedStatsGlobal)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  const ExpectedStatsRegion = fs.readFileSync(Path.join(__dirname, 'expected.StatsRegion.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/stats/region/:sequence_id', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/stats/region/NC_000962'
        }))
        assert.equal(body, ExpectedStatsRegion)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  // DEPRECATED
  // const ExpectedStatsRegionFeatureDensities = fs.readFileSync(Path.join(__dirname, 'expected.StatsRegionFeatureDensities.json'), {
  //   encoding: 'utf8'
  // })
  // it('GET /genome/:id/stats/regionFeatureDensities/:sequence_id', function (done) {
  //   (async () => {
  //     const body = await httpGet(Object.assign(rqlRequestOptions, {
  //       path: '/genome/83332.12/stats/regionFeatureDensities/NC_000962?annotation=PATRIC&start=0&end=99999&basesPerBin=10000'
  //     }))
  //     assert.equal(body, ExpectedStatsRegionFeatureDensities)
  //     done()
  //   })()
  // })

  const ExpectedFeatures = fs.readFileSync(Path.join(__dirname, 'expected.features.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/features/:seq_accession?annotation=:annotation&start=:start&end=:end', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/features/NC_000962?annotation=PATRIC&start=0&end=99999'
        }))
        assert.equal(body, ExpectedFeatures)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  const ExpectedRefseq = fs.readFileSync(Path.join(__dirname, 'expected.refseqs.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/refseqs', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/refseqs'
        }))
        assert.equal(body, ExpectedRefseq)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })

  const ExpectedNames = fs.readFileSync(Path.join(__dirname, 'expected.names.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/names/', function (done) {
    (async () => {
      try {
        const body = await httpGet(Object.assign(rqlRequestOptions, {
          path: '/jbrowse/genome/83332.12/names/'
        }))
        assert.equal(body, ExpectedNames)
        done()
      } catch (error) {
        done(error)
      }
    })()
  })
})
