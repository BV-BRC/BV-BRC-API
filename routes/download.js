const Express = require('express')
const Router = Express.Router({ strict: true, mergeParams: true })
const BodyParser = require('body-parser')
const debug = require('debug')('p3api-server:route/download')
const HttpParamsMiddleWare = require('../middleware/http-params')
const AuthMiddleware = require('../middleware/auth')
const QueryString = require('querystring')
const Archiver = require('archiver')
const Path = require('path')

// Whitelist of allowed bundle type extensions for genome downloads
// These are the valid file types that can be downloaded from the genome bundle endpoint
// Security: Prevents path traversal attacks (TIKI-W094-10)
const ALLOWED_BUNDLE_TYPES = [
  // FASTA files
  '.fna',           // Nucleotide FASTA
  '.faa',           // Amino acid FASTA
  '.ffn',           // FASTA of gene nucleotide sequences
  '.frn',           // FASTA of non-coding RNA sequences

  // PATRIC annotation files
  '.PATRIC.faa',
  '.PATRIC.ffn',
  '.PATRIC.frn',
  '.PATRIC.fna',
  '.PATRIC.gff',
  '.PATRIC.features.tab',
  '.PATRIC.pathway.tab',
  '.PATRIC.spgene.tab',
  '.PATRIC.subsystem.tab',
  '.PATRIC.cds.tab',

  // RefSeq annotation files
  '.RefSeq.faa',
  '.RefSeq.ffn',
  '.RefSeq.frn',
  '.RefSeq.fna',
  '.RefSeq.gff',
  '.RefSeq.features.tab',
  '.RefSeq.pathway.tab',
  '.RefSeq.spgene.tab',
  '.RefSeq.cds.tab',

  // General feature/annotation files
  '.gff',
  '.features.tab',
  '.pathway.tab',
  '.spgene.tab',
  '.subsystem.tab',
  '.cds.tab'
]

/**
 * Validate a bundle type against the whitelist
 * @param {string} bundleType - The bundle type to validate
 * @returns {boolean} - True if the bundle type is valid
 */
function isValidBundleType(bundleType) {
  if (!bundleType || typeof bundleType !== 'string') {
    return false
  }

  // Block any path traversal attempts
  if (bundleType.includes('..') || bundleType.includes('/') || bundleType.includes('\\')) {
    return false
  }

  // The bundleType can be prefixed with * for glob matching (e.g., "*PATRIC.faa")
  const cleanType = bundleType.startsWith('*') ? bundleType.substring(1) : bundleType

  // Check if it matches any allowed type (case-insensitive suffix match)
  return ALLOWED_BUNDLE_TYPES.some(allowed => {
    return cleanType.toLowerCase().endsWith(allowed.toLowerCase())
  })
}

/**
 * Validate an array of bundle types
 * @param {string[]} bundleTypes - Array of bundle types to validate
 * @returns {object} - Object with valid boolean and invalidTypes array
 */
function validateBundleTypes(bundleTypes) {
  const invalidTypes = []

  for (const bt of bundleTypes) {
    if (!isValidBundleType(bt)) {
      invalidTypes.push(bt)
    }
  }

  return {
    valid: invalidTypes.length === 0,
    invalidTypes
  }
}

Router.use(HttpParamsMiddleWare)
Router.use(AuthMiddleware)

Router.get('*', [
  function (req, res, next) {
    let url = req.url
    if (url.match(/^\/\?/)) {
      url = url.replace(/^\/\?/, '')
    }
    const query = QueryString.parse(url)
    if (query.types) {
      req.bundleTypes = query.types.split(',') || []
    } else {
      req.bundleTypes = []
    }

    if (query.query || query.q) {
      req.query = query.query || query.q
    }

    if (query.archiveType) {
      req.archiveType = query.archiveType
    }

    req.sourceDataType = req.params.dataType
    next()
  }
])

Router.post('*', [
  BodyParser.urlencoded({ extended: true }),
  function (req, res, next) {
    if (req.body.types) {
      req.bundleTypes = req.body.types.split(',') || []
    } else {
      req.bundleTypes = []
    }

    if (req.body.query || req.body.q) {
      req.query = req.body.query || req.body.q
    }

    if (req.body.archiveType) {
      req.archiveType = req.body.archiveType
    }

    req.sourceDataType = req.params.dataType
    next()
  }
])

Router.use(function (req, res, next) {
  debug(`req.content-type: ${req.get('content-type')}`)
  debug(`req.query: ${req.query}`)
  debug(`req.bundleTypes: ${req.bundleTypes}`)
  debug(`req.archiveType: ${req.archiveType}`)
  next()
})

Router.use([
  function (req, res, next) {
    if (!req.sourceDataType) {
      return next(new Error('Source Data Type Missing'))
    }

    if (!req.query) {
      return next(new Error('Missing Source Query'))
    }

    if (!req.bundleTypes || req.bundleTypes.length < 1) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing Bundled Types')
      return
    }

    // Security: Validate bundle types against whitelist to prevent path traversal
    const validation = validateBundleTypes(req.bundleTypes)
    if (!validation.valid) {
      console.log(`[SECURITY] Blocked invalid bundle types: ${validation.invalidTypes.join(', ')} from ${req.ip || req.connection.remoteAddress}`)
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Invalid bundle type specified')
      return
    }

    next()
  },
  function (req, res, next) {
    try {
      const bundler = require('../bundler/' + req.sourceDataType)
      bundler(req, res, next)
    } catch (err) {
      return next(new Error(`Invalid Source Data Type ${err}`))
    }
  },
  function (req, res, next) {
    if (!req.bulkMap) {
      next('route')
    }

    const archOpts = {}
    let type

    if (req.archiveType) {
      type = req.archiveType
    } else {
      switch (req.headers.accept) {
        case 'application/x-tar':
          type = 'tar'
          break
        case 'application/x-zip':
        default:
          type = 'zip'
      }
    }

    if (type === 'tar') {
      archOpts.gzip = true
      res.attachment('PATRIC_Export.tgz')
    } else if (type === 'zip') {
      res.attachment('PATRIC_Export.zip')
    }

    const archive = Archiver.create(type, archOpts)
    archive.pipe(res)
    for (let i = 0; i < req.bulkMap.length; i++) {
      const baseFolder = req.bulkMap[i].cwd
      const dest = req.bulkMap[i].dest
      for (let j = 0; j < req.bulkMap[i].src.length; j++) {
        const fileName = req.bulkMap[i].src[j]
        const filePath = Path.join(dest, fileName)

        archive.glob(filePath, { cwd: baseFolder })
      }
    }
    archive.finalize()
  }
])

module.exports = Router
