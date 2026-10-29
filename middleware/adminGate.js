/**
 * adminGate — authorization for /admin.
 *
 * Two independent factors, both required:
 *
 *   1. the request's PEER SOCKET ADDRESS is loopback
 *   2. X-Admin-Token matches `admin.token` from config
 *
 * WHY THE SOCKET ADDRESS AND NOTHING ELSE
 *
 * `req.socket.remoteAddress` is the TCP peer. An off-path attacker cannot forge it,
 * because completing the handshake requires receiving the SYN-ACK. Every other notion of
 * "who sent this" available here is client-supplied:
 *
 *   - `X-Forwarded-For` / `X-Real-IP` are headers; anyone may set them.
 *   - `req.ip` is Express's view, which consults those headers when `trust proxy` is set.
 *     This app sets no `trust proxy` today, but a future change to it must not silently
 *     turn this gate into a header check — hence reading the socket directly rather than
 *     req.ip, even though they coincide right now.
 *
 * Note the access log is NOT evidence of origin: app.js's `remote-ip` token prefers
 * `x-forwarded-for` over the socket, so it prints whatever the client claimed.
 *
 * THIS IS SOUND ONLY BECAUSE NGINX RUNS ON A SEPARATE HOST.
 *
 * Proxied traffic therefore arrives from the proxy's address, never loopback, so
 * "loopback" genuinely means "a process on this machine." **If nginx is ever colocated
 * with the API, every proxied request becomes loopback and factor 1 silently admits the
 * internet.** That is the single assumption to re-check before trusting this elsewhere,
 * and it is why factor 2 exists.
 *
 * A TRAP WORTH KNOWING
 *
 * This host reaches itself over its PUBLIC address — netstat on alpha shows many
 * `140.221.39.6:13001 <- 140.221.39.6:*` connections, and the cache warmer was one of
 * them, using https://alpha.bv-brc.org/api. Those are on-host callers whose peer address
 * is NOT loopback, so they are refused. Admin callers must use 127.0.0.1 explicitly.
 * The 403 body says so, because the alternative is a baffling failure.
 */

const Config = require('../config')

// Every spelling of loopback this stack can present. The IPv4-mapped form is not
// hypothetical: the listener is dual-stack (`:::13001`), so IPv4 clients arrive as
// `::ffff:127.0.0.1`. Matching only '127.0.0.1' would refuse real local callers.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function adminConfig () {
  return Config.get('admin') || {}
}

function isEnabled () {
  return adminConfig().enabled === true
}

/**
 * Is the TCP peer loopback?
 * @param {Object} req
 * @returns {boolean}
 */
function isLoopbackPeer (req) {
  // req.socket is the modern name; req.connection is the legacy alias still used
  // elsewhere in this codebase. Neither is client-controlled.
  const sock = req.socket || req.connection
  const addr = sock && sock.remoteAddress
  if (!addr) {
    // No peer address means we cannot prove locality. Fail closed.
    return false
  }
  return LOOPBACK.has(addr)
}

/**
 * Constant-time-ish comparison, to avoid leaking the token by response timing.
 * Not cryptographically rigorous — the length check alone leaks length — but it costs
 * nothing and removes the trivial byte-by-byte oracle.
 */
function tokenMatches (supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Express middleware. Rejects with 404 when disabled, 403 otherwise.
 *
 * 404 rather than 403 when disabled is deliberate: a disabled surface should be
 * indistinguishable from one that does not exist.
 */
function adminGate (req, res, next) {
  if (!isEnabled()) {
    return res.status(404).json({ error: 'Not found' })
  }

  const cfg = adminConfig()

  // Fail CLOSED on a missing token rather than degrading to address-only. An operator
  // who enables admin without setting a token gets a clear refusal, not a quietly
  // weaker gate.
  if (!cfg.token) {
    console.error('[ADMIN] refused: admin.enabled is true but admin.token is not set')
    return res.status(403).json({ error: 'Admin access is not configured' })
  }

  if (!isLoopbackPeer(req)) {
    const peer = (req.socket || req.connection || {}).remoteAddress
    console.log(`[SECURITY] Refused /admin from non-loopback peer ${peer} path=${req.originalUrl}`)
    return res.status(403).json({
      error: 'Admin endpoints are reachable only from localhost. ' +
             'Connect to 127.0.0.1 directly — the host\'s own public address does not qualify.'
    })
  }

  if (!tokenMatches(req.get('X-Admin-Token'), cfg.token)) {
    console.log(`[SECURITY] Refused /admin: bad or missing token, path=${req.originalUrl}`)
    return res.status(403).json({ error: 'Invalid or missing X-Admin-Token' })
  }

  next()
}

module.exports = adminGate
module.exports.isLoopbackPeer = isLoopbackPeer
module.exports.isEnabled = isEnabled
module.exports.tokenMatches = tokenMatches
module.exports.LOOPBACK = LOOPBACK
