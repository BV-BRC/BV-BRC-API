# XSS Vulnerability Fix - BV-BRC API

## Vulnerability Summary

**Type:** Reflected Cross-Site Scripting (XSS)  
**Severity:** High  
**Affected Endpoints:** All API endpoints (particularly `/api-for-website/*`)  
**Attack Vector:** Arbitrary parameter names in query strings

## Vulnerability Details

The BV-BRC API was vulnerable to Reflected XSS attacks through malicious parameter names in URL query strings. The vulnerability existed in two places:

### 1. Parameter Name Injection
In `middleware/http-params.js`, query parameter names were not validated before being:
- Included in the reconstructed query string
- Reflected in error messages
- Potentially logged or displayed

**Example Attack:**
```
GET /protein_feature?foo<script>alert(document.domain)</script>=1
```

The parameter name `foo<script>alert(document.domain)</script>` would be:
1. Parsed without validation
2. Included in `req._parsedUrl.query`
3. Passed to RQL parser
4. Reflected in error messages if parsing failed

### 2. HTTP Header Injection
The `http_*` parameter feature allowed setting arbitrary HTTP headers without validation:

**Example Attack:**
```
GET /genome?http_accept=<script>alert(1)</script>
```

This would set `req.headers['accept']` to the malicious payload.

## Fixes Implemented

### 1. Parameter Name Validation (`middleware/http-params.js`)

Added `isValidParameterName()` function that only allows safe characters:
- Alphanumeric: `a-zA-Z0-9`
- Special chars for RQL syntax: `_-.,()` 
- Blocks: `<>'"&` and other HTML/script characters

```javascript
function isValidParameterName(name) {
  return /^[a-zA-Z0-9_\-.,()]+$/.test(name)
}
```

Invalid parameter names are now:
- Blocked and not processed
- Logged with security warning
- Truncated in logs to prevent log injection

### 2. HTTP Header Whitelist (`middleware/http-params.js`)

Restricted `http_*` parameters to only set whitelisted headers:
- `accept`
- `range`
- `content-type`

Added `sanitizeHeaderValue()` to remove dangerous characters from header values.

### 3. Error Message Sanitization (`middleware/RQLQueryParser.js`)

Added `sanitizeErrorMessage()` function that:
- Removes HTML special characters: `<>'"&`
- Limits message length to 200 characters
- Prevents XSS via error message reflection

### 4. Security Headers (`app.js`)

Added defense-in-depth HTTP security headers:
- `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
- `X-Frame-Options: DENY` - Prevents clickjacking
- `X-XSS-Protection: 1; mode=block` - Enables browser XSS filter
- `Content-Security-Policy` - Restricts script execution

## Testing

### Test Cases

1. **Malicious Parameter Name:**
```bash
curl "http://localhost:3001/genome?foo<script>alert(1)</script>=bar"
# Expected: Parameter blocked, warning logged
```

2. **Malicious Header Value:**
```bash
curl "http://localhost:3001/genome?http_accept=<script>alert(1)</script>"
# Expected: Value sanitized, warning logged
```

3. **Unauthorized Header:**
```bash
curl "http://localhost:3001/genome?http_authorization=malicious"
# Expected: Header not set, attempt logged
```

4. **Valid RQL Query:**
```bash
curl "http://localhost:3001/genome?eq(genome_id,123)"
# Expected: Works normally
```

### Verification

After applying fixes, verify:
1. ✅ XSS payloads in parameter names are blocked
2. ✅ Only whitelisted headers can be set via `http_*` parameters
3. ✅ Error messages don't reflect unsanitized input
4. ✅ Security headers are present in responses
5. ✅ Legitimate queries still work correctly

## Security Best Practices

### For Developers

1. **Input Validation:** Always validate input before processing
2. **Output Encoding:** Sanitize data before including in responses
3. **Whitelist Approach:** Use whitelists instead of blacklists
4. **Defense in Depth:** Multiple layers of security (validation + CSP + headers)
5. **Logging:** Log security events for monitoring

### For Deployment

1. **Monitor Logs:** Watch for security warnings in logs
2. **Rate Limiting:** Consider adding rate limiting to prevent abuse
3. **WAF:** Deploy a Web Application Firewall for additional protection
4. **Regular Updates:** Keep dependencies updated
5. **Security Scanning:** Regular vulnerability scans

## Additional Recommendations

### Short Term
- [ ] Add rate limiting middleware
- [ ] Implement request logging with sanitization
- [ ] Add automated security tests
- [ ] Review other user input points

### Long Term
- [ ] Implement Content Security Policy reporting
- [ ] Add input validation library (e.g., joi, validator)
- [ ] Security audit of all middleware
- [ ] Penetration testing
- [ ] Security training for developers

## References

- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

## Contact

For security issues, please contact the security team immediately.

**Do not** disclose security vulnerabilities publicly until they have been addressed.