/**
 * Enrichment must never overwrite a value the document already has.
 *
 * LIVE BUG, reported 2026-11-02 from beta. `segment` was added to the shared genome
 * metadata set and so became joinable on `genome_sequence` — whose contigs carry their
 * OWN segment, and a more specific one. Selecting it replaced the contig's value with
 * the genome's full list:
 *
 *   Solr:                     segment = "6"            (an influenza NA contig)
 *   API, no select():         segment = "6"            (no join runs)
 *   API, select(segment):     segment = ["1","1","2","2",...,"8","8"]   <- the GENOME's
 *
 * A plausible-looking document with the wrong value and no error — this codebase's
 * characteristic failure.
 *
 * Two layers are tested, because either alone is insufficient: the config must not
 * declare such a field joinable, AND the merge must refuse to overwrite regardless, so
 * a future config mistake degrades to "not enriched" rather than to corrupted data.
 */

const assert = require('chai').assert
const BatchJoiner = require('../../lib/BatchJoiner')
const { DEFAULT_JOIN_CONFIG, NATIVE_FIELD_OVERRIDES } = require('../../lib/joinConfig')

const joiner = (foreign) => new BatchJoiner(
  { async fetchByIdsAsDict () { return { G1: foreign } } }, { cacheSize: 5 })

const spec = (fields) => ({
  targetCollection: 'genome',
  localField: 'genome_id',
  foreignField: 'genome_id',
  fields
})

describe('native fields are never shadowed by enrichment', function () {
  describe('layer 1: the config does not offer them', function () {
    it('genome_sequence does NOT list segment as joinable', function () {
      const f = DEFAULT_JOIN_CONFIG.collections.genome_sequence.joinableFields
      assert.notProperty(f, 'segment',
        'contigs own their segment; joining the genome value replaces it')
    })

    it('other collections still get segment — they have no native one', function () {
      for (const c of ['genome_feature', 'pathway', 'subsystem', 'sp_gene', 'genome_amr']) {
        assert.property(DEFAULT_JOIN_CONFIG.collections[c].joinableFields, 'segment',
          `${c} should still be able to enrich segment`)
      }
    })

    it('genome_sequence keeps every OTHER shared field', function () {
      const f = DEFAULT_JOIN_CONFIG.collections.genome_sequence.joinableFields
      for (const name of ['host_name', 'isolation_country', 'subtype', 'h5_clade']) {
        assert.property(f, name)
      }
    })

    it('declares the override explicitly, so it is reviewable', function () {
      assert.deepEqual(NATIVE_FIELD_OVERRIDES.genome_sequence, ['segment'])
    })
  })

  describe('layer 2: the merge refuses to overwrite', function () {
    it('preserves a native value the document already carries', async function () {
      // The reported case, reduced.
      const out = await joiner({ genome_id: 'G1', segment: ['1', '2', '3'] })
        .enrichDocs([{ sequence_id: 'c1', genome_id: 'G1', segment: '6' }],
          spec(['segment']), { publicFree: true })
      assert.equal(out[0].segment, '6', 'the contig value must survive')
    })

    it('still enriches a field the document lacks', async function () {
      const out = await joiner({ genome_id: 'G1', host_name: 'Human' })
        .enrichDocs([{ sequence_id: 'c1', genome_id: 'G1' }],
          spec(['host_name']), { publicFree: true })
      assert.equal(out[0].host_name, 'Human')
    })

    it('handles a mix in one spec', async function () {
      const out = await joiner({ genome_id: 'G1', segment: ['1', '2'], host_name: 'Human' })
        .enrichDocs([{ sequence_id: 'c1', genome_id: 'G1', segment: '6' }],
          spec(['segment', 'host_name']), { publicFree: true })
      assert.equal(out[0].segment, '6', 'present: kept')
      assert.equal(out[0].host_name, 'Human', 'absent: enriched')
    })

    it('treats null and undefined as absent, so sparse docs still enrich', async function () {
      // A Solr doc omits an empty field entirely, but a null must not block enrichment
      // either -- that would silently disable it for rows the client cares about most.
      for (const blank of [null, undefined]) {
        const out = await joiner({ genome_id: 'G1', host_name: 'Human' })
          .enrichDocs([{ genome_id: 'G1', host_name: blank }],
            spec(['host_name']), { publicFree: true })
        assert.equal(out[0].host_name, 'Human', `${blank} should be treated as absent`)
      }
    })

    it('does not overwrite a falsy-but-real value', async function () {
      // 0 and '' are real values. Treating them as absent would reintroduce the bug
      // for numeric and empty-string fields.
      const out = await joiner({ genome_id: 'G1', gc_content: 99 })
        .enrichDocs([{ genome_id: 'G1', gc_content: 0 }],
          spec(['gc_content']), { publicFree: true })
      assert.equal(out[0].gc_content, 0, '0 is a value, not a gap')
    })

    it('counts shadowed fields, so the condition is observable', async function () {
      const j = joiner({ genome_id: 'G1', segment: ['1', '2'] })
      await j.enrichDocs([{ genome_id: 'G1', segment: '6' }], spec(['segment']), { publicFree: true })
      assert.isAbove(j.stats.shadowed || 0, 0)
    })
  })
})

/**
 * Audit: which joinable names are also native somewhere?
 *
 * Measured against the live API 2026-11-02 via /:collection/fields (NOT /schema, which
 * returns `{status, message}` to an unauthenticated caller -- an audit script that read
 * it compared against an empty field list and reported a false all-clear):
 *
 *   genome_sequence . segment       <- HARMFUL: different value, caused the bug
 *   <all six>       . genome_name   <- harmless: denormalised copy, verified identical
 *   <all six>       . taxon_id      <- harmless: same
 *
 * The harmless ones are only harmless while the copies stay in sync. The no-overwrite
 * rule in BatchJoiner means they stay correct even if they drift.
 */
describe('joinable/native name collisions', function () {
  const { DEFAULT_JOIN_CONFIG } = require('../../lib/joinConfig')

  it('genome_name and taxon_id remain joinable despite colliding', function () {
    // They are denormalised onto every genome-keyed collection with the same value, so
    // excluding them would lose enrichment for collections that lack them, to prevent
    // an override that is a no-op. The merge rule handles them instead.
    for (const c of Object.keys(DEFAULT_JOIN_CONFIG.collections)) {
      const f = DEFAULT_JOIN_CONFIG.collections[c].joinableFields
      assert.property(f, 'genome_name', `${c} keeps genome_name joinable`)
      assert.property(f, 'taxon_id', `${c} keeps taxon_id joinable`)
    }
  })

  it('a denormalised copy is preserved, not re-fetched over', async function () {
    // Even where the values normally agree, the native one wins -- so a drifted copy
    // shows the collection's own data rather than being silently rewritten.
    const out = await joiner({ genome_id: 'G1', genome_name: 'FROM GENOME' })
      .enrichDocs([{ genome_id: 'G1', genome_name: 'FROM COLLECTION' }],
        spec(['genome_name']), { publicFree: true })
    assert.equal(out[0].genome_name, 'FROM COLLECTION')
  })
})
