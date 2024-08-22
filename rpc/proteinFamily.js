const debug = require('debug')('p3api-server:ProteinFamily')
const { httpGet, httpRequest } = require('../util/http')
const Config = require('../config')
const http = require('http')
const Web = require('../web')

const agent = Web.getSolrAgentForConfig({
    keepAlive: true,
    maxSockets: 1
});

const redis = require('redis')
const redisOptions = Config.get('redis')
const redisClient = redis.createClient(redisOptions)
const RedisTTL = 60 * 60 * 24 // sec

function fetchFamilyDescriptionBatch (familyIdList) {
  return new Promise((resolve, reject) => {
    const familyRefHash = {}

    redisClient.mget(familyIdList, async (err, replies) => {
      if (err) {
        reject(new Error(`Unable to read family description from redis: ${err}`))
        return
      }
      const missingIds = []
      replies.forEach((reply, i) => {
        if (reply == null) {
          missingIds.push(familyIdList[i])
        } else {
          redisClient.expire(familyIdList[i], RedisTTL)
          familyRefHash[familyIdList[i]] = reply
        }
      })

      if (missingIds.length === 0) {
        resolve(familyRefHash)
      } else {
        httpRequest({
          port: Config.get('http_port'),
          agent: agent,
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/solrquery+x-www-form-urlencoded'
          },
          path: '/protein_family_ref/'
        }, `q=family_id:(${missingIds.join(' OR ')})&fl=family_id,family_product&rows=${missingIds.length}`).then((body) => {
          try {
            const parsed = JSON.parse(body)
            parsed.forEach(family => {
              redisClient.set(family.family_id, family.family_product, 'EX', RedisTTL)
              familyRefHash[family.family_id] = family.family_product
            })
          } catch (perr) {
            reject(new Error('Error Parsing JSON response from solr: ' + perr))
            return
          }

          resolve(familyRefHash)
        }, (error) => {
          reject(error)
        })
      }
    })
  })
}

async function fetchFamilyDescriptions (familyIdList) {
  const fetchSize = 3000
  const steps = Math.ceil(familyIdList.length / fetchSize)
  const allRequests = []
  const qSt = Date.now()

  for (let i = 0; i < steps; i++) {
    const subFamilyIdList = familyIdList.slice(i * fetchSize, Math.min((i + 1) * fetchSize, familyIdList.length))

    allRequests.push(fetchFamilyDescriptionBatch(subFamilyIdList))
  }

  debug('protein_family_ref checking cache took', (Date.now() - qSt) / 1000, 's')

  try {
    const body = await Promise.all(allRequests)
    debug('protein_family_ref took', (Date.now() - qSt) / 1000, 's')

    return body.reduce((r, b) => {
      return Object.assign(r, b)
    }, {})
  } catch (err) {
    return err
  }
}

async function fetchFamilyDataByGenomeId (genomeId, options) {
  return new Promise((resolve, reject) => {
    const key = 'pfs_' + genomeId

    redisClient.get(key, async (err, familyData) => {
      if (err) {
        reject(new Error(`Unable to read family data from redis: ${err}`))
        return
      }
      if (familyData == null) {
        debug(`no cached data for ${key}`)

        httpGet({
          port: Config.get('http_port'),
          agent: agent,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/solrquery+x-www-form-urlencoded',
            'Authorization': options.token || ''
          },
          path: `/genome_feature/?q=genome_id:${genomeId}+AND+annotation:PATRIC+AND+feature_type:CDS&rows=25000&fl=pgfam_id,plfam_id,figfam_id,aa_length`
        }).then((res) => {
          const body = JSON.parse(res)
          if (typeof body === 'object') {
            redisClient.set(key, JSON.stringify(body), 'EX', RedisTTL)
            resolve(body)
          } else {
            reject(new Error(`Unable to retrieve genome object: ${genomeId}`))
          }
        }, (error) => {
          reject(error)
        })
      } else {
        // hit cache
        redisClient.expire(key, RedisTTL)
        resolve(JSON.parse(familyData))
      }
    })
  })
}

async function fetchFamilyData (familyType, genomeIdList, options) {
  const familyIdField = familyType + '_id'

  const qSt = Date.now()
  const body = []
  for (let i = 0, len = genomeIdList.length; i < len; i++) {
    body[i] = await fetchFamilyDataByGenomeId(genomeIdList[i], options)
  }

  debug('fetching family data took ', (Date.now() - qSt) / 1000, 's')

  const totalFamilyIdDict = {}

  body.forEach((data, i) => {
    const genomeId = genomeIdList[i]

    data.forEach(row => {
      const fid = row[familyIdField]
      if (fid === '' || fid === undefined) return

      if (totalFamilyIdDict.hasOwnProperty(fid)) {
        if (totalFamilyIdDict[fid].hasOwnProperty(genomeId)) {
          totalFamilyIdDict[fid][genomeId].push(row['aa_length'])
        } else {
          // has fid, but not genome id
          totalFamilyIdDict[fid][genomeId] = [row['aa_length']]
        }
      } else {
        totalFamilyIdDict[fid] = {}
        totalFamilyIdDict[fid][genomeId] = [row['aa_length']]
      }
    })
  })
  return totalFamilyIdDict
}

async function processProteinFamily (pfState, options) {
  // moved from MemoryStore implementation.
  const familyType = pfState['familyType']
  const genomeIds = pfState.genomeIds

  try {
    const totalFamilyIdDict = await fetchFamilyData(familyType, genomeIds, options)
    const familyIdList = Object.keys(totalFamilyIdDict)

    const familyRefHash = await fetchFamilyDescriptions(familyIdList)

    const qSt = Date.now()
    const data = []
    familyIdList.sort().forEach(familyId => {
      const proteins = genomeIds.map(genomeId => {
        return totalFamilyIdDict[familyId][genomeId]
      })
        .filter(row => row !== undefined)
        .reduce((total, proteins) => {
          return total.concat(proteins)
        }, [])

      const aa_length_max = Math.max.apply(Math, proteins)
      const aa_length_min = Math.min.apply(Math, proteins)
      const aa_length_sum = proteins.reduce((total, val) => total + val, 0)
      const aa_length_mean = aa_length_sum / proteins.length
      const aa_length_variance = proteins.map(val => Math.pow(val - aa_length_mean, 2))
        .reduce((total, val) => total + val, 0) / proteins.length
      const aa_length_std = Math.sqrt(aa_length_variance)

      // debug(proteins, aa_length_mean, aa_length_variance, aa_length_std);

      const genomeString = genomeIds.map(genomeId => {
        if (totalFamilyIdDict[familyId].hasOwnProperty(genomeId)) {
          const hexCount = (totalFamilyIdDict[familyId][genomeId].length).toString(16)
          return (hexCount.length === 1) ? `0${hexCount}` : hexCount
        } else {
          return '00'
        }
      }).join('')

      const row = {
        family_id: familyId,
        feature_count: proteins.length,
        genome_count: Object.keys(totalFamilyIdDict[familyId]).length,
        aa_length_std: aa_length_std,
        aa_length_max: aa_length_max,
        aa_length_mean: aa_length_mean,
        aa_length_min: aa_length_min,
        description: familyRefHash[familyId],
        genomes: genomeString
      }
      data.push(row)
    })

    debug('processing protein family data took ', (Date.now() - qSt) / 1000, 's')

    return data
  } catch (err) {
    return err
  }
}

module.exports = {
  requireAuthentication: false,
  validate: function (params) {
    const pfState = params[0]
    return pfState && pfState.genomeIds.length > 0
  },
  execute: async function (params) {
    return new Promise((resolve, reject) => {
      const pfState = params[0]
      const opts = params[1]

      processProteinFamily(pfState, opts).then((result) => {
        resolve(result)
      }, (err) => {
        reject(new Error(`Unable to process protein family queries. ${err}`))
      })
    })
  }
}
