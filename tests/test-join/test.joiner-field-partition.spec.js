/**
 * BatchJoiner's cache is partitioned by FIELD SET, not just by permission scope.
 *
 * A cached row holds only the fields its originating fetch asked for, and `_enrichDoc`
 * reads `foreignData[field]`. Without field partitioning, a later request for a
 * DIFFERENT field gets a cache hit on a row that does not contain it, and the field is
 * **silently dropped** — the document keeps its other values, nothing errors, and the
 * column is simply empty. Intermittent, too, since it depends on cache state.
 *
 * That was harmless while every collection exposed the same two-to-four fields, because
 * every cached row always had them. The genome metadata set (33 optional fields on five
 * collections) makes subset collisions ordinary, which is why this is now pinned.
 *
 * Offline: the Solr client is a stub that records what it was asked for.
 */

const assert = require('chai').assert
const BatchJoiner = require('../../lib/BatchJoiner')

/** Stub Solr that returns only the requested `fl`, as real Solr does. */
function stubSolr (rows) {
  const calls = []
  return {
    calls,
    async fetchByIdsAsDict (collection, keyField, keys, opts = {}) {
      calls.push({ collection, keys: [...keys], fl: opts.fl })
      const wanted = (opts.fl || '').split(',').filter(Boolean)
      const out = {}
      for (const k of keys) {
        const full = rows[k]
        if (!full) continue
        // Project: a real Solr response contains ONLY the fl fields.
        out[k] = wanted.reduce((acc, f) => {
          if (full[f] !== undefined) acc[f] = full[f]
          return acc
        }, {})
      }
      return out
    }
  }
}

const GENOMES = {
  '83332.12': {
    genome_id: '83332.12',
    genome_name: 'Mycobacterium tuberculosis H37Rv',
    host_name: 'Homo sapiens',
    isolation_country: 'USA',
    habitat: 'Host-associated'
  }
}

const spec = (fields) => ({
  targetCollection: 'genome',
  localField: 'genome_id',
  foreignField: 'genome_id',
  fields
})

const docs = () => [{ feature_id: 'f1', genome_id: '83332.12' }]

describe('BatchJoiner field-set cache partitioning', function () {
  let joiner, solr

  beforeEach(function () {
    solr = stubSolr(GENOMES)
    joiner = new BatchJoiner(solr, { cacheSize: 50 })
  })

  it('a narrow fetch does NOT silently satisfy a later wider request', async function () {
    // THE REGRESSION. Fails against an unpartitioned cache: request 2 gets a hit on
    // request 1's row, which has no isolation_country, and the field vanishes.
    const first = await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    assert.equal(first[0].host_name, 'Homo sapiens')

    const second = await joiner.enrichDocs(docs(), spec(['isolation_country']), { publicFree: true })
    assert.equal(second[0].isolation_country, 'USA',
      'a different field set must not be served from the previous entry')
  })

  it('refetches for the new field set rather than guessing', async function () {
    await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    await joiner.enrichDocs(docs(), spec(['isolation_country']), { publicFree: true })
    assert.lengthOf(solr.calls, 2, 'the second field set needs its own fetch')
    assert.include(solr.calls[0].fl, 'host_name')
    assert.include(solr.calls[1].fl, 'isolation_country')
  })

  it('still caches: an identical field set is not refetched', async function () {
    // The partitioning must not destroy the hit rate it exists alongside.
    await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    assert.lengthOf(solr.calls, 1, 'same fields + same scope must hit cache')
  })

  it('treats field order as the same partition', async function () {
    await joiner.enrichDocs(docs(), spec(['host_name', 'habitat']), { publicFree: true })
    await joiner.enrichDocs(docs(), spec(['habitat', 'host_name']), { publicFree: true })
    assert.lengthOf(solr.calls, 1, '{a,b} and {b,a} are the same set')
  })

  it('serves a multi-field request correctly after a single-field one', async function () {
    await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    const out = await joiner.enrichDocs(
      docs(), spec(['host_name', 'isolation_country', 'habitat']), { publicFree: true })
    assert.equal(out[0].host_name, 'Homo sapiens')
    assert.equal(out[0].isolation_country, 'USA')
    assert.equal(out[0].habitat, 'Host-associated')
  })

  it('keeps permission scoping intact alongside field partitioning', async function () {
    // Both dimensions must partition; neither may be dropped in favour of the other.
    await joiner.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    await joiner.enrichDocs(docs(), spec(['host_name']),
      { user: { id: 'someone@patricbrc.org' }, publicFree: false })
    assert.lengthOf(solr.calls, 2, 'a different permission scope must refetch')
  })

  it('does not resurrect a cached null across field sets', async function () {
    // Absent keys are cached as null. That null means "not present with THESE fields",
    // and must not suppress a fetch for a different set.
    const empty = stubSolr({})
    const j = new BatchJoiner(empty, { cacheSize: 50 })
    await j.enrichDocs(docs(), spec(['host_name']), { publicFree: true })
    await j.enrichDocs(docs(), spec(['isolation_country']), { publicFree: true })
    assert.lengthOf(empty.calls, 2)
  })
})

describe('genome metadata join fields', function () {
  const { DEFAULT_JOIN_CONFIG, GENOME_METADATA_FIELDS } = require('../../lib/joinConfig')
  const { buildJoinSpecs } = require('../../lib/joinConfig')

  const COLLECTIONS = ['genome_feature', 'pathway', 'subsystem', 'sp_gene', 'genome_amr']

  it('exposes the metadata set on EVERY genome-keyed collection', function () {
    for (const c of COLLECTIONS) {
      const fields = DEFAULT_JOIN_CONFIG.collections[c].joinableFields
      for (const f of GENOME_METADATA_FIELDS) {
        assert.property(fields, f, `${c} should expose ${f}`)
      }
    }
  })

  it('omits deprecated and unstored fields', function () {
    // Exposing these would advertise as current a surface we intend to shrink;
    // collection_date_dr is stored="false", so Solr cannot return it at all.
    const excluded = [
      'isolation_site', 'latitude', 'longitude', 'altitude', 'depth',
      'body_sample_site', 'body_sample_subsite',
      'antimicrobial_resistance', 'antimicrobial_resistance_evidence',
      'collection_date_dr'
    ]
    for (const c of COLLECTIONS) {
      const fields = DEFAULT_JOIN_CONFIG.collections[c].joinableFields
      for (const f of excluded) {
        assert.notProperty(fields, f, `${c} must not expose deprecated/unstored ${f}`)
      }
    }
  })

  it('keeps the pre-existing fields', function () {
    const gf = DEFAULT_JOIN_CONFIG.collections.genome_feature.joinableFields
    for (const f of ['genome_name', 'taxon_id', 'genome_status', 'strain']) {
      assert.property(gf, f)
    }
  })

  it('collapses many metadata fields into ONE lookup', function () {
    // The reason 33 fields is not 33 queries: they share from+via, so buildJoinSpecs
    // groups them. If this ever regresses, a metadata download becomes unusable.
    const fields = DEFAULT_JOIN_CONFIG.collections.genome_feature.joinableFields
    const specs = buildJoinSpecs(GENOME_METADATA_FIELDS, fields)
    assert.lengthOf(specs, 1, 'all genome metadata is one grouped lookup')
    assert.equal(specs[0].targetCollection, 'genome')
    assert.equal(specs[0].localField, 'genome_id')
    assert.lengthOf(specs[0].fields, GENOME_METADATA_FIELDS.length)
  })
})
