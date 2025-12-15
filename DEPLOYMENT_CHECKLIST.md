# XSS Vulnerability Fix - Deployment Checklist

## Pre-Deployment Testing

### 1. Test XSS Protection

```bash
# These should be BLOCKED (parameter rejected):
curl "http://localhost:3001/genome?foo<script>alert(1)</script>=bar"
curl "http://localhost:3001/genome?test'><img src=x onerror=alert(1)>=value"
curl "http://localhost:3001/genome?param&malicious=value"

# Expected: 400 error or parameter silently dropped
# Check logs for: [SECURITY] Blocked invalid parameter name
```

### 2. Test Valid RQL Queries

```bash
# These should WORK normally:
curl "http://localhost:3001/genome?eq(genome_id,*)"
curl "http://localhost:3001/genome?and(eq(public,true),eq(genome_id,123))"
curl "http://localhost:3001/genome?select(genome_id,genome_name,owner)"
curl "http://localhost:3001/genome?limit(25)&sort(+genome_name)"

# Expected: Normal API response (200 or 404)
```

### 3. Test Header Protection

```bash
# Should be BLOCKED:
curl "http://localhost:3001/genome?http_authorization=malicious"
curl "http://localhost:3001/genome?http_cookie=stolen"

# Should WORK (whitelisted):
curl "http://localhost:3001/genome?http_accept=application/json"

# Should be SANITIZED:
curl "http://localhost:3001/genome?http_accept=<script>alert(1)</script>"
```

### 4. Test Security Headers

```bash
curl -I "http://localhost:3001/genome"

# Expected headers:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Content-Security-Policy: default-src 'self'; script-src 'none'; object-src 'none'
```

### 5. Run Automated Tests

```bash
npm test

# Specifically run security tests:
npm test -- test/security-xss.test.js
```

## Deployment Steps

### Step 1: Code Review ✅
- [ ] Review all changes in `middleware/http-params.js`
- [ ] Review all changes in `middleware/RQLQueryParser.js`
- [ ] Review all changes in `app.js`
- [ ] Verify no legitimate functionality is broken

### Step 2: Staging Deployment
- [ ] Deploy to staging environment
- [ ] Run all pre-deployment tests on staging
- [ ] Test with real-world queries from production logs
- [ ] Monitor staging logs for 1 hour
- [ ] Verify no false positives (legitimate queries blocked)

### Step 3: Production Deployment
- [ ] Schedule deployment during low-traffic window
- [ ] Deploy to production
- [ ] Immediately test critical endpoints
- [ ] Monitor error rates
- [ ] Check for security warnings in logs

### Step 4: Post-Deployment Monitoring (24 hours)
- [ ] Monitor for `[SECURITY]` log messages
- [ ] Check error rate trends
- [ ] Review any 400 errors for false positives
- [ ] Verify security headers are present
- [ ] Test with known attack patterns

## Rollback Plan

If issues are detected:

```bash
# Revert the changes:
git revert <commit-hash>

# Or restore previous version:
git checkout <previous-commit> -- middleware/http-params.js
git checkout <previous-commit> -- middleware/RQLQueryParser.js
git checkout <previous-commit> -- app.js
```

## Monitoring Queries

### Check for blocked attacks:
```bash
grep "\[SECURITY\] Blocked invalid parameter name" /var/log/api.log | tail -20
```

### Check for sanitized headers:
```bash
grep "\[SECURITY\] Sanitized potentially malicious" /var/log/api.log | tail -20
```

### Monitor error rates:
```bash
grep "400" /var/log/api.log | wc -l
```

## Success Criteria

✅ **Security:**
- XSS payloads in parameter names are blocked
- Unauthorized headers cannot be set
- Error messages don't reflect unsanitized input
- Security headers present in all responses

✅ **Functionality:**
- All valid RQL queries work correctly
- No increase in legitimate 400 errors
- API performance unchanged
- No user complaints

✅ **Monitoring:**
- Security warnings logged appropriately
- No false positives detected
- Attack attempts visible in logs

## Communication

### Internal Team
- [ ] Notify DevOps team of deployment
- [ ] Brief support team on potential issues
- [ ] Update security team on fix status

### External (if needed)
- [ ] Notify security researcher who reported issue
- [ ] Update security advisory (if published)
- [ ] Document in release notes

## Files Changed

**Critical Files:**
- `middleware/http-params.js` - Parameter validation
- `middleware/RQLQueryParser.js` - Error sanitization
- `app.js` - Security headers

**Documentation:**
- `SECURITY_FIX.md` - Detailed fix documentation
- `VULNERABILITY_REPORT.md` - Security report
- `DEPLOYMENT_CHECKLIST.md` - This file

**Tests:**
- `test/security-xss.test.js` - Security test suite

## Sign-off

- [ ] Developer: _______________  Date: _______
- [ ] Code Reviewer: _______________  Date: _______
- [ ] Security Team: _______________  Date: _______
- [ ] DevOps: _______________  Date: _______
- [ ] Deployment Complete: _______________  Date: _______
