const debug = require('debug')('p3api-server:cacheClass')
const Fs = require('fs-extra')
const Config = require('./config')
const Path = require('path')
const Touch = require('touch')

const CACHE_DIR = Config.get('cache').directory
debug('Using Cache Dir: ', CACHE_DIR)

module.exports = {
  get: function (key, options) {
    options = options || {}

    if (!options.user) {
      options.user = 'public'
    }

    return new Promise((resolve, reject) => {
      const fileName = Path.join(CACHE_DIR, options.user, key)
      debug('Check for Cached Data in: ', fileName)
      Fs.exists(fileName, (exists) => {
        if (!exists) {
          reject(new Error(`File does not exist`))
          return
        }

        Fs.readJson(fileName, (err, data) => {
          if (err) {
            return reject(err)
          }
          resolve(data)
          Touch(fileName)
        })
      })
    })
  },

  put: function (key, data, options) {
    options = options || {}

    if (!options.user) {
      options.user = 'public'
    }

    return new Promise((resolve, reject) => {
      const fileName = Path.join(CACHE_DIR, options.user, key)
      debug('Store Cached Data to: ', fileName)
      Fs.outputJson(fileName, data, (err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(true)
      })
    })
  }
}
