const assert = require('chai').assert
const Http = require('http')
const { httpGet } = require('../../util/http')
const Path = require('path')
const Fs = require('fs')
const Config = require('../../config')

const agent = new Http.Agent({
  keepAlive: true,
  maxSockets: 1
})

const rqlRequestOptions = {
  port: Config.get('http_port'),
  agent: agent,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/rqlquery+x-www-form-urlencoded'
  }
}

describe('Test Router - JBrowse', function () {
  const ExpectedTrackList = Fs.readFileSync(Path.join(__dirname, 'expected.trackList.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/trackList', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/trackList'
    }))
      .then((body) => {
        assert.equal(body, ExpectedTrackList)
      })
  })

  const ExpectedTracks = Fs.readFileSync(Path.join(__dirname, 'expected.tracks.json'), {
    encoding: 'utf8'
  })
  it('GET /genome/:id/tracks', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/tracks'
    }))
      .then((body) => {
        assert.equal(body, ExpectedTracks)
      })
  })

  const ExpectedStatsGlobal = Fs.readFileSync(Path.join(__dirname, 'expected.StatsGlobal.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/stats/global', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/stats/global'
    }))
      .then((body) => {
        assert.equal(body, ExpectedStatsGlobal)
      })
  })

  const ExpectedStatsRegion = Fs.readFileSync(Path.join(__dirname, 'expected.StatsRegion.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/stats/region/:sequence_id', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/stats/region/NC_000962'
    }))
      .then((body) => {
        assert.equal(body, ExpectedStatsRegion)
      })
  })

  // DEPRECATED
  // const ExpectedStatsRegionFeatureDensities = Fs.readFileSync(Path.join(__dirname, 'expected.StatsRegionFeatureDensities.json'), {
  //   encoding: 'utf8'
  // })
  // it('GET /genome/:id/stats/regionFeatureDensities/:sequence_id', async function () {
  //   return httpGet(Object.assign(rqlRequestOptions, {
  //     path: '/genome/83332.12/stats/regionFeatureDensities/NC_000962?annotation=PATRIC&start=0&end=99999&basesPerBin=10000'
  //   }))
  //     .then((body) => {
  //       assert.equal(body, ExpectedStatsRegionFeatureDensities)
  //     })
  // })

  const ExpectedFeatures = Fs.readFileSync(Path.join(__dirname, 'expected.features.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/features/:seq_accession?annotation=:annotation&start=:start&end=:end', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/features/NC_000962?annotation=PATRIC&start=0&end=99999'
    }))
      .then((body) => {
        assert.equal(body, ExpectedFeatures)
      })
  })

  const ExpectedRefseq = Fs.readFileSync(Path.join(__dirname, 'expected.refseqs.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/refseqs', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/refseqs'
    }))
      .then((body) => {
        assert.equal(body, ExpectedRefseq)
      })
  })

  const ExpectedNames = Fs.readFileSync(Path.join(__dirname, 'expected.names.json'), {
    encoding: 'utf8'
  })
  it('GET /jbrowse/genome/:id/names/', async function () {
    return httpGet(Object.assign(rqlRequestOptions, {
      path: '/jbrowse/genome/83332.12/names/'
    }))
      .then((body) => {
        assert.equal(body, ExpectedNames)
      })
  })
})
