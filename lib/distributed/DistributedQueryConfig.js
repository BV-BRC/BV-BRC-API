/**
 * Distributed Query Configuration Manager
 *
 * Manages configuration for distributed query system with support for
 * runtime updates via privileged API.
 */

const Config = require('../../config')
const debug = require('debug')('p3api-server:distributed:config')

// Runtime configuration (can be updated via admin API)
let runtimeConfig = null

/**
 * Get the current distributed query configuration.
 * Returns runtime config if set, otherwise falls back to config file.
 *
 * @returns {Object} Configuration object
 */
function getConfig () {
  if (runtimeConfig) {
    return { ...getDefaults(), ...runtimeConfig }
  }
  return getDefaults()
}

/**
 * Get default configuration from config file.
 *
 * @returns {Object} Default configuration
 */
function getDefaults () {
  const fileConfig = Config.get('distributedQuery') || {}
  return {
    maxParallelism: fileConfig.maxParallelism || 8,
    maxRetries: fileConfig.maxRetries || 3,
    initialRetryDelayMs: fileConfig.initialRetryDelayMs || 100,
    schemaCacheTTLMinutes: fileConfig.schemaCacheTTLMinutes || 60,
    clusterStatusCacheTTLSeconds: fileConfig.clusterStatusCacheTTLSeconds || 60,
    maxMergeSortHeapDocs: fileConfig.maxMergeSortHeapDocs || 10000,
    maxMemoryMB: fileConfig.maxMemoryMB || 32,
    cursorBatchSize: fileConfig.cursorBatchSize || 2000,
    excludeNodes: fileConfig.excludeNodes || [],
    adminUsers: fileConfig.adminUsers || [],
    // SSL/TLS options for self-signed certificates
    rejectUnauthorized: fileConfig.rejectUnauthorized !== false, // default true
    ca: fileConfig.ca || null // path to CA cert file or PEM content
  }
}

/**
 * Update runtime configuration.
 * Only specified fields are updated; others retain current values.
 *
 * @param {Object} updates - Configuration fields to update
 * @returns {Object} Updated configuration
 */
function updateConfig (updates) {
  const current = getConfig()
  const validKeys = Object.keys(getDefaults())

  // Filter to only valid configuration keys
  const filteredUpdates = {}
  for (const key of Object.keys(updates)) {
    if (validKeys.includes(key)) {
      filteredUpdates[key] = updates[key]
    } else {
      debug(`Ignoring unknown config key: ${key}`)
    }
  }

  // Validate values
  if (filteredUpdates.maxParallelism !== undefined) {
    const val = parseInt(filteredUpdates.maxParallelism, 10)
    if (isNaN(val) || val < 1 || val > 100) {
      throw new Error('maxParallelism must be between 1 and 100')
    }
    filteredUpdates.maxParallelism = val
  }

  if (filteredUpdates.maxRetries !== undefined) {
    const val = parseInt(filteredUpdates.maxRetries, 10)
    if (isNaN(val) || val < 0 || val > 10) {
      throw new Error('maxRetries must be between 0 and 10')
    }
    filteredUpdates.maxRetries = val
  }

  if (filteredUpdates.initialRetryDelayMs !== undefined) {
    const val = parseInt(filteredUpdates.initialRetryDelayMs, 10)
    if (isNaN(val) || val < 10 || val > 10000) {
      throw new Error('initialRetryDelayMs must be between 10 and 10000')
    }
    filteredUpdates.initialRetryDelayMs = val
  }

  if (filteredUpdates.maxMergeSortHeapDocs !== undefined) {
    const val = parseInt(filteredUpdates.maxMergeSortHeapDocs, 10)
    if (isNaN(val) || val < 100 || val > 100000) {
      throw new Error('maxMergeSortHeapDocs must be between 100 and 100000')
    }
    filteredUpdates.maxMergeSortHeapDocs = val
  }

  if (filteredUpdates.cursorBatchSize !== undefined) {
    const val = parseInt(filteredUpdates.cursorBatchSize, 10)
    if (isNaN(val) || val < 100 || val > 10000) {
      throw new Error('cursorBatchSize must be between 100 and 10000')
    }
    filteredUpdates.cursorBatchSize = val
  }

  // Merge updates
  runtimeConfig = { ...current, ...filteredUpdates }
  debug('Configuration updated:', runtimeConfig)

  return runtimeConfig
}

/**
 * Reset runtime configuration to defaults.
 *
 * @returns {Object} The default configuration
 */
function resetConfig () {
  runtimeConfig = null
  debug('Configuration reset to defaults')
  return getDefaults()
}

/**
 * Check if a user is authorized to modify configuration.
 *
 * @param {string} userId - User ID to check
 * @returns {boolean} True if user is authorized
 */
function isAdminUser (userId) {
  const config = getConfig()
  return config.adminUsers.includes(userId)
}

/**
 * Get list of admin users.
 *
 * @returns {string[]} Copy of admin user IDs list
 */
function getAdminUsers () {
  return [...getConfig().adminUsers]
}

module.exports = {
  getConfig,
  getDefaults,
  updateConfig,
  resetConfig,
  isAdminUser,
  getAdminUsers
}
