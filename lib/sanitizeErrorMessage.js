/**
 * Strip anything that could execute in a browser out of an error message, and cap its
 * length, before it is echoed back to a client.
 *
 * This lived in middleware/RQLQueryParser.js, which re-exported it so lib/internalQuery.js
 * could classify RQL errors exactly the way the HTTP path does. That import became a
 * require cycle in PLAN_ELIMINATE_SELF_CALL step 6:
 *
 *   ExpandingQuery -> lib/internalQuery -> middleware/RQLQueryParser -> ExpandingQuery
 *
 * and the cycle is not benign. RQLQueryParser assigns `module.exports = function (...)`,
 * replacing the exports object, so whichever module in the ring is required first sees a
 * stale `{}` for its partner. Verified: loading lib/internalQuery first leaves
 * ExpandingQuery's `internalQuery` binding `undefined`, and the failure surfaces only when
 * a query actually needs it. Neither module needs the other's Express behavior — they need
 * this one function — so it lives on its own and both require it directly.
 *
 * RQLQueryParser still re-exports it; existing callers (routes/multiQuery.js) are unchanged.
 *
 * @param {string} message - Raw error message
 * @returns {string} Message safe to place in a JSON error body
 */
function sanitizeErrorMessage (message) {
  if (!message) return 'Invalid query'
  // Remove HTML tags and limit length
  return String(message).replace(/[<>"'&]/g, '').substring(0, 200)
}

module.exports = sanitizeErrorMessage
module.exports.sanitizeErrorMessage = sanitizeErrorMessage
