/**
 * Utility functions for the distributed query module
 */

const { URL } = require('url')

/**
 * Sanitize a URL by removing username and password.
 * Used for logging to avoid exposing credentials.
 *
 * @param {string} urlString - URL that may contain credentials
 * @returns {string} URL with credentials replaced by ***
 */
function sanitizeUrl (urlString) {
  if (!urlString) return urlString

  try {
    const parsed = new URL(urlString)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : ''
      parsed.password = parsed.password ? '***' : ''
      return parsed.toString()
    }
    return urlString
  } catch (err) {
    // If URL parsing fails, try regex replacement as fallback
    // Matches user:pass@ or user@ patterns
    return urlString.replace(/\/\/[^:]+:[^@]+@/, '//***:***@').replace(/\/\/[^:@]+@/, '//***@')
  }
}

module.exports = {
  sanitizeUrl
}
