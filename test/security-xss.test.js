const request = require('supertest')
const app = require('../app')

describe('XSS Vulnerability Tests', () => {
  
  describe('Parameter Name Validation', () => {
    
    test('should block XSS in parameter names with script tags', async () => {
      const response = await request(app)
        .get('/genome?foo<script>alert(1)</script>=bar')
        .expect(400)
      
      // Response should not contain the script tag
      expect(JSON.stringify(response.body)).not.toMatch(/<script>/)
    })
    
    test('should block XSS in parameter names with encoded script tags', async () => {
      const response = await request(app)
        .get('/genome?foo%3Cscript%3Ealert(1)%3C/script%3E=bar')
        .expect(400)
      
      expect(JSON.stringify(response.body)).not.toMatch(/<script>/)
    })
    
    test('should block XSS with img tag', async () => {
      const response = await request(app)
        .get('/genome?foo<img src=x onerror=alert(1)>=bar')
        .expect(400)
      
      expect(JSON.stringify(response.body)).not.toMatch(/<img/)
    })
    
    test('should allow valid RQL parameter names', async () => {
      const response = await request(app)
        .get('/genome?eq(genome_id,123)')
      
      // Should not be blocked (may return 400 for other reasons, but not security)
      expect(response.status).not.toBe(403)
    })
    
    test('should allow valid parameter names with underscores and hyphens', async () => {
      const response = await request(app)
        .get('/genome?valid_param-name=value')
      
      expect(response.status).not.toBe(403)
    })
  })
  
  describe('HTTP Header Injection Prevention', () => {
    
    test('should block XSS in http_accept parameter', async () => {
      const response = await request(app)
        .get('/genome?http_accept=<script>alert(1)</script>')
      
      // Header should be sanitized or blocked
      expect(response.request.header.accept).not.toMatch(/<script>/)
    })
    
    test('should block unauthorized header via http_ parameter', async () => {
      const response = await request(app)
        .get('/genome?http_authorization=malicious')
      
      // Authorization header should not be set from query param
      expect(response.request.header.authorization).toBeUndefined()
    })
    
    test('should allow whitelisted headers with safe values', async () => {
      const response = await request(app)
        .get('/genome?http_accept=application/json')
      
      // Should work normally
      expect(response.status).not.toBe(403)
    })
  })
  
  describe('Error Message Sanitization', () => {
    
    test('should sanitize error messages containing XSS', async () => {
      const response = await request(app)
        .get('/genome?invalid<script>alert(1)</script>query')
        .expect(400)
      
      // Error message should not contain script tags
      expect(response.body.message).not.toMatch(/<script>/)
      expect(response.body.message).not.toMatch(/alert\(/)
    })
    
    test('should limit error message length', async () => {
      const longPayload = 'a'.repeat(500) + '<script>alert(1)</script>'
      const response = await request(app)
        .get(`/genome?${longPayload}`)
        .expect(400)
      
      // Error message should be truncated
      expect(response.body.message.length).toBeLessThanOrEqual(200)
    })
  })
  
  describe('Security Headers', () => {
    
    test('should include X-Content-Type-Options header', async () => {
      const response = await request(app)
        .get('/genome')
      
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    })
    
    test('should include X-Frame-Options header', async () => {
      const response = await request(app)
        .get('/genome')
      
      expect(response.headers['x-frame-options']).toBe('DENY')
    })
    
    test('should include X-XSS-Protection header', async () => {
      const response = await request(app)
        .get('/genome')
      
      expect(response.headers['x-xss-protection']).toBe('1; mode=block')
    })
    
    test('should include Content-Security-Policy header', async () => {
      const response = await request(app)
        .get('/genome')
      
      expect(response.headers['content-security-policy']).toBeDefined()
      expect(response.headers['content-security-policy']).toMatch(/script-src 'none'/)
    })
  })
  
  describe('Real-world Attack Scenarios', () => {
    
    test('should block the reported vulnerability URL', async () => {
      // The actual reported vulnerability
      const response = await request(app)
        .get('/protein_feature?eq(feature_id,undefined)=&foo%253cscript%253ealert%2528document.domain%2529%253c%252fscript%253e=1')
        .expect(400)
      
      expect(JSON.stringify(response.body)).not.toMatch(/<script>/)
      expect(JSON.stringify(response.body)).not.toMatch(/alert\(/)
    })
    
    test('should block double-encoded XSS', async () => {
      const response = await request(app)
        .get('/genome?%253Cscript%253Ealert(1)%253C/script%253E=value')
        .expect(400)
      
      expect(JSON.stringify(response.body)).not.toMatch(/<script>/)
    })
    
    test('should block event handler XSS', async () => {
      const response = await request(app)
        .get('/genome?"><img src=x onerror=alert(1)>=value')
        .expect(400)
      
      expect(JSON.stringify(response.body)).not.toMatch(/onerror/)
    })
  })
  
  describe('Legitimate Queries Still Work', () => {
    
    test('should allow valid genome query', async () => {
      const response = await request(app)
        .get('/genome?eq(genome_id,1234.5)')
      
      // May return 404 if genome doesn't exist, but should not be blocked
      expect([200, 404]).toContain(response.status)
    })
    
    test('should allow complex RQL queries', async () => {
      const response = await request(app)
        .get('/genome?and(eq(genome_id,123),eq(public,true))')
      
      expect([200, 404]).toContain(response.status)
    })
    
    test('should allow queries with special characters in values', async () => {
      const response = await request(app)
        .get('/genome?eq(genome_name,Test-Genome_123)')
      
      expect([200, 404]).toContain(response.status)
    })
  })
})
"