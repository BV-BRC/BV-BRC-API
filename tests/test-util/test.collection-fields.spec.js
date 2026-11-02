/**
 * GET /:collection/fields — the field-description payload.
 *
 * The website uses this to build a column picker, so the contract that matters is:
 * every selectable field appears exactly once, each carries a readable label, and each
 * is flagged native vs enriched. Getting any of those wrong produces a picker offering
 * columns that come back empty — which is this codebase's usual failure shape.
 *
 * Offline: `describeFields` is pure, taking a schema object.
 */

const assert = require('chai').assert
const { describeFields } = require('../../lib/collectionFields')
const { fieldLabel, deriveLabel } = require('../../lib/fieldLabels')

/** A Solr schema response in the shape getSchema() returns. */
const schema = (fields) => ({ schema: { fields } })

const NATIVE = [
  { name: 'feature_id', type: 'string', stored: true },
  { name: 'genome_id', type: 'string', stored: true },
  { name: 'product', type: 'text', stored: true },
  { name: 'na_length', type: 'int', stored: true },
  { name: 'go', type: 'string', stored: true, multiValued: true }
]

describe('collection field description', function () {
  describe('native fields', function () {
    it('reports stored schema fields with labels and a native flag', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      const f = out.fields.find((x) => x.name === 'feature_id')
      assert.deepInclude(f, { name: 'feature_id', label: 'Feature ID', source: 'native' })
    })

    it('EXCLUDES unstored fields — they cannot be returned', function () {
      // An unstored field is indexed and filterable but never returned, so offering it
      // as a selectable column yields a permanently empty column. genome's
      // collection_date_dr is exactly this.
      const out = describeFields('genome', schema([
        ...NATIVE,
        { name: 'collection_date_dr', type: 'rdate', stored: false }
      ]))
      assert.notOk(out.fields.find((x) => x.name === 'collection_date_dr'))
    })

    it('excludes _version_ and dynamic-field patterns', function () {
      const out = describeFields('genome_feature', schema([
        ...NATIVE,
        { name: '_version_', type: 'long', stored: true },
        { name: '*_txt', type: 'text', stored: true }
      ]))
      assert.notOk(out.fields.find((x) => x.name === '_version_'))
      assert.notOk(out.fields.find((x) => x.name === '*_txt'))
    })

    it('carries type and multiValued through', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      const go = out.fields.find((x) => x.name === 'go')
      assert.equal(go.type, 'string')
      assert.isTrue(go.multiValued)
    })
  })

  describe('enriched fields', function () {
    it('reports joinable fields with their origin', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      const hn = out.fields.find((x) => x.name === 'host_name')
      assert.isOk(hn, 'genome metadata should be offered on genome_feature')
      assert.equal(hn.source, 'enriched')
      assert.equal(hn.from, 'genome')
      assert.equal(hn.via, 'genome_id')
      assert.equal(hn.hops, 1)
    })

    it('offers the metadata set on every genome-keyed collection', function () {
      for (const c of ['genome_feature', 'pathway', 'subsystem', 'sp_gene', 'genome_amr']) {
        const out = describeFields(c, schema(NATIVE))
        assert.isOk(out.fields.find((x) => x.name === 'isolation_country'),
          `${c} should offer isolation_country`)
      }
    })

    it('offers nothing enriched for a collection with no join config', function () {
      const out = describeFields('taxonomy', schema(NATIVE))
      assert.equal(out.counts.enriched, 0)
      assert.isAbove(out.counts.native, 0)
    })

    it('does NOT duplicate a field that is both native and joinable', function () {
      // genome_id is native on genome_feature and is also the join key. Listing it
      // twice would imply a choice that does not exist — the native value wins.
      const out = describeFields('genome_feature', schema(NATIVE))
      const hits = out.fields.filter((x) => x.name === 'genome_id')
      assert.lengthOf(hits, 1)
      assert.equal(hits[0].source, 'native')
    })
  })

  describe('the payload as a whole', function () {
    it('counts native and enriched separately and they sum to the total', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      assert.equal(out.counts.native + out.counts.enriched, out.counts.total)
      assert.equal(out.counts.total, out.fields.length)
    })

    it('names the collection and sorts fields by name', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      assert.equal(out.collection, 'genome_feature')
      const names = out.fields.map((f) => f.name)
      assert.deepEqual(names, [...names].sort())
    })

    it('gives every field a non-empty label', function () {
      const out = describeFields('genome_feature', schema(NATIVE))
      for (const f of out.fields) {
        assert.isNotEmpty(f.label, `${f.name} must have a label`)
      }
    })

    it('tolerates an empty or malformed schema rather than throwing', function () {
      for (const bad of [null, undefined, {}, { schema: {} }, { fields: [] }]) {
        assert.doesNotThrow(() => describeFields('genome_feature', bad))
      }
      // Enriched fields are still reported when the schema is unavailable.
      assert.isAbove(describeFields('genome_feature', {}).counts.enriched, 0)
    })

    it('accepts the bare { fields: [...] } shape as well as { schema: { fields } }', function () {
      const out = describeFields('genome_feature', { fields: NATIVE })
      assert.isAbove(out.counts.native, 0)
    })
  })
})

describe('field labels', function () {
  it('derives title case from snake_case', function () {
    assert.equal(deriveLabel('host_common_name'), 'Host Common Name')
    assert.equal(deriveLabel('season'), 'Season')
  })

  it('uses overrides where derivation reads badly', function () {
    // 'Genome Id' and 'Patric Id' are what derivation produces; neither is acceptable.
    assert.equal(fieldLabel('genome_id'), 'Genome ID')
    assert.equal(fieldLabel('patric_id'), 'BRC ID')
    assert.equal(fieldLabel('gc_content'), 'GC Content')
    assert.equal(fieldLabel('trna'), 'tRNA')
  })

  it('falls back to derivation for anything unlisted', function () {
    assert.equal(fieldLabel('some_new_field'), 'Some New Field')
  })

  it('handles empty and non-string input', function () {
    for (const bad of [null, undefined, '', 0, {}]) {
      assert.equal(fieldLabel(bad), '')
    }
  })
})

/**
 * Regression: config.js must not carry a `joinEnrichment` default.
 *
 * It used to hold a second full copy of the collections map, and that copy SILENTLY WON.
 * `getJoinConfig()` spreads p3api.conf's `joinEnrichment` over the defaults per
 * collection, and a default declared in config.js is indistinguishable from one an
 * operator wrote — so it overrode lib/joinConfig.js completely, and adding a joinable
 * field there had no effect whatsoever. Found when 33 new genome metadata fields did not
 * appear in the enrichment config at all.
 *
 * This is precisely the duplication hazard lib/joinConfig.js's own header warns about:
 * "a grammar implemented twice will drift, and the failure mode is a silently unenriched
 * field."
 */
describe('join config has exactly one source', function () {
  const Config = require('../../config')
  const { getJoinConfig, DEFAULT_JOIN_CONFIG } = require('../../lib/joinConfig')

  it('config.js declares NO joinEnrichment default', function () {
    // With no p3api.conf override present, this must be undefined — anything else means
    // a default has been reintroduced and lib/joinConfig.js is being shadowed.
    const saved = Config.get('joinEnrichment')
    try {
      Config.set('joinEnrichment', undefined)
      assert.isUndefined(Config.get('joinEnrichment'),
        'add joinable fields to lib/joinConfig.js, not config.js')
    } finally {
      Config.set('joinEnrichment', saved)
    }
  })

  it('the effective config matches lib/joinConfig.js when nothing overrides it', function () {
    const saved = Config.get('joinEnrichment')
    try {
      Config.set('joinEnrichment', undefined)
      const effective = getJoinConfig()
      for (const c of Object.keys(DEFAULT_JOIN_CONFIG.collections)) {
        assert.deepEqual(
          Object.keys(effective.collections[c].joinableFields).sort(),
          Object.keys(DEFAULT_JOIN_CONFIG.collections[c].joinableFields).sort(),
          `${c}: effective config must equal the module default`)
      }
    } finally {
      Config.set('joinEnrichment', saved)
    }
  })

  it('an operator override in p3api.conf still wins, as documented', function () {
    const saved = Config.get('joinEnrichment')
    try {
      Config.set('joinEnrichment', {
        collections: { genome_feature: { joinableFields: { only_this: { from: 'genome', via: 'genome_id', field: 'only_this' } } } }
      })
      const fields = getJoinConfig().collections.genome_feature.joinableFields
      assert.property(fields, 'only_this')
      assert.notProperty(fields, 'host_name', 'a configured collection replaces the default')
    } finally {
      Config.set('joinEnrichment', saved)
    }
  })
})
