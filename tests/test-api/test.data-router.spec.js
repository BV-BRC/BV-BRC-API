/**
 * /data/* characterization tests — routes/dataRouter.js
 *
 * PLAN_ELIMINATE_SELF_CALL.md step 3. These exist to pin the *current*,
 * observable behaviour of the four /data endpoints before step 5 rewrites
 * `subQuery()` from an HTTP self-call to an in-process `lib/internalQuery` call.
 * Their job is to fail if that rewrite changes anything a client can see.
 *
 * WHY THIS SUITE DOES NOT STUB THE SELF-CALL
 * ------------------------------------------
 * tests/test-api/test.multiquery-errors.spec.js stands up a stub of the inner
 * `/:dataType/` endpoint and points the router at it via the `http_port` env var.
 * Do NOT copy that pattern here. Step 5 *removes* the self-call, so a test built
 * on intercepting it would break by construction and would be rewritten in the
 * same commit it is supposed to be guarding. These tests therefore drive the real
 * route over HTTP and assert only on what comes back out.
 *
 * EXPECTATIONS ARE DERIVED AT RUNTIME
 * -----------------------------------
 * BV-BRC data is continuously ingested, so every count here drifts. Nothing is
 * hardcoded: counts are cross-checked against the same collections queried
 * directly through the API in the same run, and everything else is asserted as a
 * structural invariant (key presence, types, sort order, sums) that holds for any
 * dataset.
 *
 * REQUIREMENTS (skipped automatically if unmet):
 *   - API running at API_URL (default http://localhost:3001; dev here is :23001)
 *   - A populated Solr behind it (genome, genome_feature, protein_structure,
 *     strain, subsystem, taxonomy)
 *
 * Requests are sent anonymously, with no Authorization header, because
 * `subQuery()` hardcodes `Authorization: ''`. Step 5 must preserve that: the
 * apicache key for these routes is `req.originalUrl` only (`appendKey: []`), so it
 * is NOT user-scoped, and letting an identity reach these queries would publish
 * private counts into a cache shared by every caller for a day.
 *
 * CACHING CAVEAT: three of the four endpoints are wrapped in
 * `cacheWithRedis('1 day')`. When using this suite to compare before/after a
 * refactor, FLUSH the API's Redis db between runs or the second run will be
 * served from the first run's cache and pass vacuously. Flush only the dev db
 * (`redis.db` in p3api.conf) — db 2 is shared with production.
 */

const assert = require('chai').assert
const http = require('http')
const https = require('https')
const { URL } = require('url')

const API_URL = process.env.API_URL || 'http://localhost:3001'

// Taxon fixtures, chosen to exercise both branches of the `=== 1` post-processing
// in summary_by_taxon. A species-level taxon collapses all three unique_* counts
// to 1 (so all three are deleted); a genus-level taxon keeps unique_species.
const TAXON_SPECIES = '1747' // Cutibacterium acnes
const TAXON_GENUS = '1912216' // Cutibacterium — small, ~0.2s, unique_species > 1
const TAXON_MULTI_FEATURE = '1279' // Staphylococcus — returns mat_peptide as well as CDS

function request (path, { accept = 'application/json', method = 'GET', body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + path)
    const mod = u.protocol === 'https:' ? https : http
    const headers = { Accept: accept }
    if (contentType) headers['Content-Type'] = contentType
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const req = mod.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('request timed out after 120s')))
    if (body) req.write(body)
    req.end()
  })
}

async function getJson (path, accept) {
  const res = await request(path, { accept })
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch (e) {
    throw new Error(`${path} returned unparsable body (status ${res.status}): ${res.body.slice(0, 200)}`)
  }
  return { status: res.status, headers: res.headers, body: parsed }
}

/**
 * numFound for a collection+fq, fetched through the API's own collection endpoint.
 * This is the runtime source of truth the /data counts are checked against, and it
 * deliberately takes the same anonymous, public-only path subQuery() takes.
 */
async function numFound (collection, fq) {
  const res = await request(`/${collection}`, {
    accept: 'application/solr+json',
    method: 'POST',
    contentType: 'application/solrquery+x-www-form-urlencoded',
    body: `q=*:*&fq=${encodeURIComponent(fq)}&rows=0`
  })
  const parsed = JSON.parse(res.body)
  return parsed.response.numFound
}

describe('/data/* — characterization (pre-internalQuery)', function () {
  this.timeout(150000)

  let apiUp = false

  before(async function () {
    try {
      const res = await request('/health', { accept: '*/*' })
      apiUp = res.status === 200
    } catch (e) {
      apiUp = false
    }
    if (!apiUp) {
      console.log(`    [skip] API not reachable at ${API_URL}`)
    }
  })

  beforeEach(function () {
    if (!apiUp) this.skip()
  })

  describe('GET /data/summary_by_taxon/:taxon_id', function () {
    it('returns a flat object of numeric counts as application/json', async function () {
      const { status, headers, body } = await getJson(`/data/summary_by_taxon/${TAXON_GENUS}`)

      assert.equal(status, 200)
      assert.match(headers['content-type'], /application\/json/)
      assert.isObject(body)
      assert.isNotArray(body)

      // The route merges four sub-queries into one flat map; every value is a count.
      Object.keys(body).forEach((k) => {
        assert.isNumber(body[k], `${k} should be numeric`)
      })

      // Keys contributed unconditionally by three of the four sub-queries.
      assert.property(body, 'count', 'genome json.facet always returns count')
      assert.property(body, 'PDB', 'from protein_structure numFound')
      assert.property(body, 'strains_count', 'from strain numFound')
    })

    it('count/PDB/strains_count match the collections queried directly', async function () {
      // The load-bearing test: it pins the meaning of each key to its source
      // collection, so a rewrite that crosses two of them up cannot pass.
      const fq = `taxon_lineage_ids:${TAXON_GENUS}`
      const [body, genomes, structures, strains] = await Promise.all([
        getJson(`/data/summary_by_taxon/${TAXON_GENUS}`).then((r) => r.body),
        numFound('genome', fq),
        numFound('protein_structure', fq),
        numFound('strain', fq)
      ])

      assert.equal(body.count, genomes, 'count comes from the genome collection')
      assert.equal(body.PDB, structures, 'PDB comes from protein_structure')
      assert.equal(body.strains_count, strains, 'strains_count comes from strain')
    })

    it('never returns a unique_* key whose value is 1', async function () {
      // This is the actual contract of the post-processing step: unique_family,
      // unique_genus and unique_species are deleted when they equal 1. Asserting
      // the invariant rather than a fixture-specific key list keeps it drift-proof.
      for (const taxon of [TAXON_SPECIES, TAXON_GENUS, TAXON_MULTI_FEATURE]) {
        const { body } = await getJson(`/data/summary_by_taxon/${taxon}`)
        for (const key of ['unique_family', 'unique_genus', 'unique_species']) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            assert.notEqual(body[key], 1,
              `${key} was present with value 1 for taxon ${taxon}; it should have been deleted`)
          }
        }
      }
    })

    it('retains a unique_* count above 1 (the deletion is conditional, not blanket)', async function () {
      // Guards the opposite failure from the test above: a rewrite that dropped
      // every unique_* key would satisfy "none equals 1" trivially.
      const { body } = await getJson(`/data/summary_by_taxon/${TAXON_GENUS}`)
      assert.property(body, 'unique_species',
        `taxon ${TAXON_GENUS} is a genus and should report more than one species`)
      assert.isAbove(body.unique_species, 1)
    })

    it('collapses all three unique_* counts for a species-level taxon', async function () {
      const { body } = await getJson(`/data/summary_by_taxon/${TAXON_SPECIES}`)
      assert.notProperty(body, 'unique_family')
      assert.notProperty(body, 'unique_genus')
      assert.notProperty(body, 'unique_species')
    })

    it('merges every feature_type facet bucket, not just CDS', async function () {
      // feature_type counts are spread onto the result object one key per bucket.
      // This fixture has mat_peptide as well as CDS; a rewrite that read only the
      // first bucket would still pass a CDS-only assertion.
      const { body } = await getJson(`/data/summary_by_taxon/${TAXON_MULTI_FEATURE}`)
      assert.property(body, 'CDS')
      assert.property(body, 'mat_peptide')
      assert.isAbove(body.CDS, 0)
    })
  })

  describe('GET /data/distinct/:collection/:field', function () {
    it('returns a value -> count map for an allowlisted pair', async function () {
      const { status, headers, body } = await getJson('/data/distinct/genome/geographic_group')

      assert.equal(status, 200)
      assert.match(headers['content-type'], /application\/json/)
      assert.isObject(body)
      assert.isNotArray(body)
      assert.isAbove(Object.keys(body).length, 0)
      Object.keys(body).forEach((k) => {
        assert.isNumber(body[k], `${k} should map to a count`)
        assert.isAbove(body[k], 0, 'facet.mincount=1 excludes empty buckets')
      })
    })

    it('rejects a non-allowlisted field with a 405 body inside an HTTP 200', async function () {
      // Quirk, deliberately pinned: the allowlist guard writes {status:405} into the
      // body but never sets the HTTP status, so this is a 200. Clients may well
      // depend on that; step 5 should not "fix" it silently.
      const { status, body } = await getJson('/data/distinct/genome/not_a_field')
      assert.equal(status, 200, 'the HTTP status is 200 despite the 405 in the body')
      assert.equal(body.status, 405)
      assert.include(body.message, 'not allowed')
    })

    it('rejects a non-allowlisted collection the same way', async function () {
      const { status, body } = await getJson('/data/distinct/nope/taxon_rank')
      assert.equal(status, 200)
      assert.equal(body.status, 405)
      assert.include(body.message, '/distinct/nope/taxon_rank')
    })

    it('honours the ?q= narrowing parameter', async function () {
      const [all, narrowed] = await Promise.all([
        getJson('/data/distinct/genome/geographic_group').then((r) => r.body),
        getJson('/data/distinct/genome/geographic_group?q=genome_status:Complete').then((r) => r.body)
      ])

      // Every narrowed bucket must exist in the unfiltered result and be no larger.
      // Asserting per-bucket rather than on the total makes this independent of
      // which buckets happen to be populated.
      const shared = Object.keys(narrowed).filter((k) => Object.prototype.hasOwnProperty.call(all, k))
      assert.isAbove(shared.length, 0, 'q= should not empty the facet')
      shared.forEach((k) => {
        assert.isAtMost(narrowed[k], all[k], `${k} must not grow when the query is narrowed`)
      })
      assert.isBelow(
        shared.reduce((s, k) => s + narrowed[k], 0),
        shared.reduce((s, k) => s + all[k], 0),
        'genome_status:Complete is a strict subset, so the totals must differ'
      )
    })
  })

  describe('GET /data/taxon_category/', function () {
    it('returns superkingdom/order/family name arrays for application/solr+json', async function () {
      const { status, body } = await getJson('/data/taxon_category/', 'application/solr+json')

      assert.equal(status, 200)
      assert.hasAllKeys(body, ['superkingdom', 'order', 'family'])
      Object.keys(body).forEach((k) => {
        assert.isArray(body[k], `${k} should be an array of names`)
        assert.isAbove(body[k].length, 0)
        body[k].forEach((v) => assert.isString(v))
      })
    })

    it('404s for application/json and for */*', async function () {
      // Quirk, deliberately pinned. This is the only /data endpoint that ends in the
      // `media` middleware, and it hands media a plain object. media/json.js requires
      // res.results.response.docs or .grouped for call_method 'query' and otherwise
      // calls res.status(404) — so the default JSON serializer, which also backs */*,
      // cannot render this route. Only the solr+json serializer works.
      for (const accept of ['application/json', '*/*']) {
        const res = await request('/data/taxon_category/', { accept })
        assert.equal(res.status, 404, `Accept: ${accept} is expected to 404 today`)
      }
    })
  })

  describe('GET /data/subsystem_summary/:genome_id', function () {
    let genomeWithSubsystems = null

    before(async function () {
      if (!apiUp) return
      // Pick a genome that actually has subsystem rows, at runtime.
      const res = await request('/subsystem', {
        accept: 'application/solr+json',
        method: 'POST',
        contentType: 'application/solrquery+x-www-form-urlencoded',
        body: 'q=*:*&rows=0&facet=true&facet.field=genome_id&facet.mincount=500&facet.limit=1&json.nl=map'
      })
      try {
        const buckets = JSON.parse(res.body).facet_counts.facet_fields.genome_id
        genomeWithSubsystems = Object.keys(buckets)[0] || null
      } catch (e) {
        genomeWithSubsystems = null
      }
    })

    it('returns an empty array for a genome with no subsystem rows', async function () {
      // 1386.5934 has none; if that ever changes the assertion below still holds
      // for any genome the facet says is empty.
      const { status, headers, body } = await getJson('/data/subsystem_summary/1386.5934')
      assert.equal(status, 200)
      assert.match(headers['content-type'], /application\/json/)
      assert.isArray(body)
      assert.lengthOf(body, 0)
    })

    it('returns a three-level tree sorted by gene_count descending', async function () {
      if (!genomeWithSubsystems) this.skip()
      const { status, body } = await getJson(`/data/subsystem_summary/${genomeWithSubsystems}`)

      assert.equal(status, 200)
      assert.isArray(body)
      assert.isAbove(body.length, 0)

      const assertSortedDesc = (nodes, where) => {
        for (let i = 1; i < nodes.length; i++) {
          assert.isAtLeast(nodes[i - 1].gene_count, nodes[i].gene_count,
            `${where} must be sorted by gene_count descending`)
        }
      }

      assertSortedDesc(body, 'superclass level')
      body.forEach((superclass) => {
        assert.isString(superclass.name)
        assert.isNumber(superclass.gene_count)
        assert.isNumber(superclass.subsystem_count)
        assert.isArray(superclass.children)
        assertSortedDesc(superclass.children, `classes of ${superclass.name}`)

        superclass.children.forEach((klass) => {
          assert.isString(klass.name)
          assert.isNumber(klass.gene_count)
          assert.isArray(klass.children)
          assertSortedDesc(klass.children, `subclasses of ${klass.name}`)

          // Leaves are subclasses: they carry counts but no children.
          klass.children.forEach((subclass) => {
            assert.isString(subclass.name)
            assert.isNumber(subclass.gene_count)
            assert.isNumber(subclass.subsystem_count)
            assert.notProperty(subclass, 'children')
          })
        })
      })
    })

    it('rolls subsystem_count up from the leaves at every level', async function () {
      // The aggregation is hand-rolled accumulator arithmetic across three nested
      // loops — exactly the kind of thing a refactor can quietly break while still
      // producing a well-shaped tree.
      if (!genomeWithSubsystems) this.skip()
      const { body } = await getJson(`/data/subsystem_summary/${genomeWithSubsystems}`)

      body.forEach((superclass) => {
        const classSum = superclass.children.reduce((s, k) => s + k.subsystem_count, 0)
        assert.equal(superclass.subsystem_count, classSum,
          `${superclass.name}: subsystem_count should equal the sum over its classes`)

        superclass.children.forEach((klass) => {
          const subclassSum = klass.children.reduce((s, sc) => s + sc.subsystem_count, 0)
          assert.equal(klass.subsystem_count, subclassSum,
            `${klass.name}: subsystem_count should equal the sum over its subclasses`)
        })
      })
    })
  })
})
