/**
 * Cross-collection download — end-to-end HTTP integration tests
 *
 * PLAN_CROSS_COLLECTION_DOWNLOAD.md. Everything else in this feature is covered
 * by unit tests with mocked Solr; this exercises the real thing over HTTP.
 *
 * That distinction earned its keep: four bugs in this feature were invisible to
 * the unit tests and only appeared here — a lost first record (the metadata
 * header convention), duplicate records across cursor pages, a silently dropped
 * source filter, and a one-to-many link truncated to one document per key. Each
 * produced a plausible-looking file. Keep asserting on counts, not just on
 * "we got bytes".
 *
 * REQUIREMENTS (skipped automatically if unmet):
 *   - API running at API_URL (default http://localhost:3001)
 *   - Local Solr with genome, genome_feature, feature_sequence, sp_gene,
 *     genome_sequence populated — see Docs/LOCAL_SOLR_SETUP.md
 *   - tests/config.json with `token` (and optionally `token2` for a second user)
 *
 * The fixture expectations below are derived at runtime from Solr rather than
 * hardcoded, so this works against any loaded dataset.
 */

const assert = require('chai').assert
const http = require('http')
const { URL } = require('url')

const API_URL = process.env.API_URL || 'http://localhost:3001'
const SOLR_URL = process.env.SOLR_URL || 'http://localhost:8983/solr'

let token = null
let token2 = null
try {
  const cfg = require('../config.json')
  token = cfg.token
  token2 = cfg.token2
} catch (e) { /* no tokens; auth-dependent tests skip */ }

/**
 * POST a download request and return { status, headers, body }.
 */
function download (path, body, authToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + path)
    const headers = { 'Content-Type': 'application/rqlquery+x-www-form-urlencoded' }
    if (authToken) headers.Authorization = authToken

    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')) })
    req.end(body)
  })
}

/** Query Solr directly, for deriving expectations. */
function solr (collection, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SOLR_URL}/${collection}/select`)
    Object.entries(params).forEach(([k, v]) => u.searchParams.append(k, v))
    u.searchParams.set('wt', 'json')
    http.get(u.toString(), (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(new Error(d.slice(0, 200))) }
      })
    }).on('error', reject)
  })
}

async function apiUp () {
  try {
    const r = await new Promise((resolve, reject) => {
      http.get(API_URL + '/health', (res) => {
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => resolve({ status: res.statusCode, body: d }))
      }).on('error', reject)
    })
    return r.status === 200
  } catch (e) { return false }
}

async function collectionHas (collection) {
  try {
    const r = await solr(collection, { q: '*:*', rows: 0 })
    return (r.response && r.response.numFound) > 0
  } catch (e) { return false }
}

const XC = '&http_source_collection=sp_gene&http_source_link_field=feature_id'

describe('Cross-collection downloads (HTTP)', function () {
  this.timeout(90000)

  let ready = false
  let owner = null            // user that owns the sp_gene fixtures
  let expectedFeatures = 0    // distinct feature_ids sp_gene references

  before(async function () {
    if (!await apiUp()) {
      console.log('    [skip] API not reachable at ' + API_URL)
      return
    }
    if (!await collectionHas('sp_gene') || !await collectionHas('genome_feature')) {
      console.log('    [skip] sp_gene / genome_feature not populated — see Docs/LOCAL_SOLR_SETUP.md')
      return
    }

    // Derive who owns the fixtures and how many distinct features they reference,
    // so assertions do not hardcode a dataset.
    const sample = await solr('sp_gene', { q: '*:*', rows: 1, fl: 'owner,public' })
    owner = sample.response.docs[0] && sample.response.docs[0].owner

    const facet = await solr('sp_gene', {
      q: '*:*',
      rows: 0,
      'json.facet': JSON.stringify({ n: { type: 'terms', field: 'feature_id', limit: 0, numBuckets: true } })
    })
    expectedFeatures = (facet.facets && facet.facets.n && facet.facets.n.numBuckets) || 0

    ready = expectedFeatures > 0
    if (!ready) console.log('    [skip] no sp_gene feature_id values found')
  })

  function needsFixtures (ctx) {
    if (!ready) ctx.skip()
  }

  function needsOwnerToken (ctx) {
    if (!ready) ctx.skip()
    if (!token) ctx.skip()
    // The token identity must match the fixture owner for these to be meaningful.
    if (!owner || !token.includes('un=' + owner)) {
      console.log(`    [skip] tests/config.json token is not the fixture owner (${owner})`)
      ctx.skip()
    }
  }

  describe('guard (no fixtures needed)', function () {
    it('rejects an unallowlisted source collection with 400', async function () {
      if (!await apiUp()) this.skip()
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' +
        '&http_source_collection=genome_amr&http_source_link_field=genome_id',
        'eq(x,1)', token)
      assert.equal(r.status, 400)
      assert.include(r.body, 'genome_amr')
    })

    it('rejects a half-specified cross-collection request with 400', async function () {
      if (!await apiUp()) this.skip()
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv&http_source_collection=sp_gene',
        'eq(x,1)', token)
      assert.equal(r.status, 400)
      assert.include(r.body, 'http_source_link_field')
    })

    it('leaves an ordinary download untouched', async function () {
      if (!await apiUp() || !await collectionHas('genome_feature')) this.skip()
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv',
        'eq(genome_id,83332.12)&select(patric_id)&sort(%2Bfeature_id)&limit(3)', token)
      assert.equal(r.status, 200)
      assert.isAbove(r.body.split('\n').filter(Boolean).length, 1)
    })
  })

  describe('resolution correctness', function () {
    it('resolves the full source set with no duplicate and no lost records', async function () {
      needsOwnerToken(this)
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' + XC,
        'select(patric_id)&limit(2500000)', token)

      assert.equal(r.status, 200)
      const rows = r.body.split('\n').filter(Boolean)
      const data = rows.slice(1) // drop CSV header

      // Exact count: catches both the lost-first-record bug (metadata header
      // convention) and the cross-batch duplicate bug in one assertion.
      assert.equal(data.length, expectedFeatures,
        'one row per distinct source link value')
      assert.equal(new Set(data).size, data.length, 'no duplicate rows')
    })

    it('applies the source filter rather than resolving everything', async function () {
      needsOwnerToken(this)

      // Pick a property value present in the fixtures and count its features.
      const facet = await solr('sp_gene', {
        q: '*:*', rows: 0, 'facet': 'true', 'facet.field': 'property', 'facet.limit': 1
      })
      const propValue = facet.facet_counts.facet_fields.property[0]
      const encoded = '%22' + encodeURIComponent(propValue).replace(/%20/g, '%20') + '%22'

      const sub = await solr('sp_gene', {
        q: `property:"${propValue}"`,
        rows: 0,
        'json.facet': JSON.stringify({ n: { type: 'terms', field: 'feature_id', limit: 0, numBuckets: true } })
      })
      const expectFiltered = sub.facets.n.numBuckets

      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' + XC,
        `eq(property,${encoded})&select(patric_id)&limit(2500000)`, token)

      assert.equal(r.status, 200)
      const data = r.body.split('\n').filter(Boolean).slice(1)
      assert.equal(data.length, expectFiltered)
      assert.isBelow(data.length, expectedFeatures,
        'a filtered download must be strictly smaller than the unfiltered one')
    })

    it('returns an empty body and X-Result-Count: 0 when nothing matches', async function () {
      needsOwnerToken(this)
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' + XC,
        'eq(property,NoSuchPropertyValueAnywhere)&select(patric_id)&limit(2500000)', token)

      assert.equal(r.status, 200)
      assert.equal(r.body.trim(), '')
      // Counts only reach the headers when no body was written — which is
      // exactly this case. See the amended Decision 1 in the plan.
      assert.equal(r.headers['x-result-count'], '0')
    })
  })

  describe('permission scoping', function () {
    it('returns nothing to an anonymous caller for private source rows', async function () {
      needsFixtures(this)
      const isPublic = (await solr('sp_gene', { q: 'public:true', rows: 0 })).response.numFound
      if (isPublic > 0) this.skip() // fixtures are public; nothing to prove

      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' + XC,
        'select(patric_id)&limit(2500000)', null)

      assert.equal(r.status, 200)
      assert.equal(r.body.trim(), '', 'anonymous must not receive private-sourced rows')
    })

    it('returns nothing to a different authenticated user', async function () {
      needsOwnerToken(this)
      if (!token2) this.skip()

      const r = await download(
        '/genome_feature/?http_download=true&http_accept=text/csv' + XC,
        'select(patric_id)&limit(2500000)', token2)

      assert.equal(r.status, 200)
      assert.equal(r.body.trim(), '',
        'a second user must not receive another user\'s private-sourced rows')
    })
  })

  describe('serializer coverage', function () {
    it('produces protein FASTA with real sequences', async function () {
      needsOwnerToken(this)
      if (!await collectionHas('feature_sequence')) {
        console.log('    [skip] feature_sequence empty — FASTA bodies would be blank')
        this.skip()
      }

      const r = await download(
        '/genome_feature/?http_download=true&http_accept=application/protein+fasta' +
        XC + '&http_fasta_id_fields=patric_id', 'select(patric_id)&limit(2500000)', token)

      assert.equal(r.status, 200)
      const records = r.body.split('\n>').filter((x) => x.trim())
      assert.isAbove(records.length, 0)

      // Every record must carry an actual sequence. An empty-sequence FASTA is
      // the failure mode when feature_sequence is unpopulated, and it looks
      // superficially like a working download.
      const empty = records.filter((rec) => !rec.split('\n').slice(1).join('').trim())
      assert.equal(empty.length, 0, 'no record may have an empty sequence')
    })

    it('produces GFF (a cross-collection format that is not FASTA)', async function () {
      if (!await apiUp() || !await collectionHas('genome_feature')) this.skip()
      if (!token) this.skip()

      // genome -> genome_feature via gff. The resolution stream emits ordinary
      // target docs, so format-specific wiring should not be needed; this proves it.
      const r = await download(
        '/genome_feature/?http_download=true&http_accept=application/gff' +
        '&http_source_collection=genome&http_source_link_field=genome_id',
        'eq(genome_id,83332.12)&limit(2500000)', token)

      assert.equal(r.status, 200)
      const lines = r.body.split('\n').filter(Boolean)
      assert.equal(lines[0], '##gff-version 3')
      const data = lines.filter((l) => !l.startsWith('#'))
      assert.isAbove(data.length, 0)
      assert.isTrue(data.every((l) => l.split('\t').length >= 9), 'valid GFF3 columns')
    })

    it('resolves a ONE-TO-MANY link (genome -> contigs) without truncating', async function () {
      if (!await apiUp() || !await collectionHas('genome_sequence')) this.skip()
      if (!token) this.skip()

      // Find a genome with several contigs that this token can see.
      const facet = await solr('genome_sequence', {
        q: '*:*', rows: 0, facet: 'true', 'facet.field': 'genome_id', 'facet.limit': 5
      })
      const buckets = facet.facet_counts.facet_fields.genome_id
      let gid = null; let count = 0
      for (let i = 0; i < buckets.length; i += 2) {
        if (buckets[i + 1] > 1) { gid = buckets[i]; count = buckets[i + 1]; break }
      }
      if (!gid) {
        console.log('    [skip] no multi-contig genome loaded')
        this.skip()
      }

      const r = await download(
        '/genome_sequence/?http_download=true&http_accept=application/dna+fasta' +
        '&http_source_collection=genome&http_source_link_field=genome_id' +
        '&http_fasta_id_fields=sequence_id',
        `eq(genome_id,${gid})&limit(2500000)`, token)

      assert.equal(r.status, 200)
      const records = (r.body.match(/^>/gm) || []).length
      // fetchByIds caps rows at values.length by default, which would truncate
      // this to 1 record for 1 genome_id.
      assert.equal(records, count, `all ${count} contigs, not one per genome`)
    })
  })
})
