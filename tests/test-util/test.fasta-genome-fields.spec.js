/**
 * FASTA header fields resolve against the join registry, and accept bare names.
 *
 * Reported from a GUI session 2026-10-30, after `/:collection/fields` shipped:
 *
 *   1. `/fields` advertised 35 enriched fields but the FASTA serializers fetched a
 *      hardcoded 8 (`GenomeMetadataJoinStream.DEFAULT_CONFIG.genomeFields`). Anything
 *      else resolved to undefined and was SILENTLY DROPPED from the header:
 *        genome_metadata.strain,genome_metadata.host_name,genome_metadata.isolation_country
 *          -> ">fig|... MGYG-HGUT-00869"     strain only
 *
 *   2. Naming. `/fields` reports bare `host_name`; FASTA required a `genome_metadata.`
 *      prefix because needsGenomeJoin() tested for that literal substring. A client
 *      that correctly consumed `/fields` and passed back what it was given got nothing
 *      at all -- including `strain`, which had worked when prefixed.
 *
 * Bare names are canonical (select() has always taken them); the prefix survives as an
 * alias so saved URLs keep working.
 *
 * Offline: pure functions over a synthetic req.
 */

const assert = require('chai').assert
const {
  bareName, requestedHeaderFields, requestedGenomeFields,
  needsGenomeJoin, genomeFieldsFor, ALWAYS_FETCH
} = require('../../lib/fastaGenomeFields')

const req = (params) => ({ fastaParams: params, call_collection: 'genome_feature' })

describe('FASTA genome field resolution', function () {
  describe('bare names — the reported breakage', function () {
    it('triggers the join for a bare genome field', function () {
      // The exact failing case: all three dropped because none carried the prefix.
      const r = req({ http_fasta_description_fields: 'strain,host_name,isolation_country' })
      assert.isTrue(needsGenomeJoin(r, 'genome_feature'))
    })

    it('fetches every requested bare field', function () {
      const fields = genomeFieldsFor(
        req({ http_fasta_description_fields: 'strain,host_name,isolation_country' }),
        'genome_feature')
      for (const f of ['strain', 'host_name', 'isolation_country']) {
        assert.include(fields, f)
      }
    })

    it('fetches fields BEYOND the old hardcoded list', function () {
      // host_name, isolation_country, habitat and disease are all absent from
      // DEFAULT_CONFIG.genomeFields -- that is why they vanished.
      const fields = genomeFieldsFor(
        req({ http_fasta_context_fields: 'habitat,disease,host_group' }), 'genome_feature')
      for (const f of ['habitat', 'disease', 'host_group']) {
        assert.include(fields, f)
      }
    })
  })

  describe('the genome_metadata. prefix still works', function () {
    it('strips the prefix', function () {
      assert.equal(bareName('genome_metadata.host_name'), 'host_name')
      assert.equal(bareName('host_name'), 'host_name')
    })

    it('triggers the join for prefixed names', function () {
      const r = req({ http_fasta_description_fields: 'genome_metadata.host_name' })
      assert.isTrue(needsGenomeJoin(r, 'genome_feature'))
      assert.include(genomeFieldsFor(r, 'genome_feature'), 'host_name')
    })

    it('treats prefixed and bare as the same field', function () {
      const mixed = req({
        http_fasta_id_fields: 'genome_metadata.strain',
        http_fasta_description_fields: 'strain'
      })
      const hits = requestedGenomeFields(mixed, 'genome_feature').filter((f) => f === 'strain')
      assert.lengthOf(hits, 1, 'must not fetch the same field twice')
    })
  })

  describe('what gets fetched', function () {
    it('always includes the join key and the historical defaults', function () {
      // Dropping these would regress anyone relying on the old implicit behaviour.
      const fields = genomeFieldsFor(req({ http_fasta_id_fields: 'host_name' }), 'genome_feature')
      for (const f of ALWAYS_FETCH) assert.include(fields, f)
      assert.include(fields, 'genome_id', 'the join key is mandatory')
    })

    it('does not fetch a field the registry does not know', function () {
      // Stops a typo becoming a wasted fl entry, and keeps FASTA from diverging from
      // the rest of the API again.
      const fields = genomeFieldsFor(
        req({ http_fasta_description_fields: 'not_a_real_field' }), 'genome_feature')
      assert.notInclude(fields, 'not_a_real_field')
    })

    it('does not trigger a join for native-only fields', function () {
      // patric_id and product live on genome_feature itself; no join needed.
      const r = req({ http_fasta_description_fields: 'patric_id,product' })
      assert.isFalse(needsGenomeJoin(r, 'genome_feature'))
    })

    it('deduplicates across the three header parameters', function () {
      const r = req({
        http_fasta_id_fields: 'host_name',
        http_fasta_description_fields: 'host_name,habitat',
        http_fasta_context_fields: 'habitat'
      })
      assert.deepEqual(requestedHeaderFields(r), ['host_name', 'habitat'])
    })

    it('tolerates absent, empty and whitespace-padded parameters', function () {
      assert.deepEqual(requestedHeaderFields({}), [])
      assert.deepEqual(requestedHeaderFields(req({})), [])
      assert.deepEqual(
        requestedHeaderFields(req({ http_fasta_id_fields: ' host_name , , habitat ' })),
        ['host_name', 'habitat'])
    })
  })

  describe('per-collection resolution', function () {
    it('resolves against the collection being served', function () {
      // The same field name must work wherever the registry offers it.
      for (const c of ['genome_feature', 'genome_sequence', 'sp_gene']) {
        assert.isTrue(needsGenomeJoin(req({ http_fasta_id_fields: 'host_name' }), c),
          `${c} should join for host_name`)
      }
    })

    it('does not join for a collection with no join config', function () {
      assert.isFalse(needsGenomeJoin(req({ http_fasta_id_fields: 'host_name' }), 'taxonomy'))
    })
  })
})

describe('genome_sequence join config', function () {
  const { DEFAULT_JOIN_CONFIG, GENOME_METADATA_FIELDS } = require('../../lib/joinConfig')

  it('offers the metadata set — it was reporting 0 enriched fields', function () {
    const fields = DEFAULT_JOIN_CONFIG.collections.genome_sequence.joinableFields
    for (const f of GENOME_METADATA_FIELDS) {
      assert.property(fields, f)
    }
  })

  it('does NOT add a self-join config for `genome`', function () {
    // genome's own 145 native fields already include this metadata; a genome->genome
    // join would be a no-op and would list every field twice in /fields.
    assert.notProperty(DEFAULT_JOIN_CONFIG.collections, 'genome')
  })
})

describe('fastaHeaderFormatter bare-name fallback', function () {
  const { createFastaHeaderFormatter } = require('../../util/fastaHeaderFormatter')

  const doc = {
    patric_id: 'fig|83332.12.peg.1',
    genome_metadata: { strain: 'H37Rv', host_name: 'Homo sapiens' }
  }

  const header = (fields) => createFastaHeaderFormatter({
    idFields: ['patric_id'], descriptionFields: fields, contextFields: []
  })(doc)

  it('resolves a BARE name from joined metadata', function () {
    assert.include(header(['host_name']), 'Homo sapiens')
  })

  it('still resolves the prefixed form', function () {
    assert.include(header(['genome_metadata.host_name']), 'Homo sapiens')
  })

  it('prefers a field present on the document itself', function () {
    const shadowed = { ...doc, strain: 'NATIVE-VALUE' }
    const out = createFastaHeaderFormatter({
      idFields: ['patric_id'], descriptionFields: ['strain'], contextFields: []
    })(shadowed)
    assert.include(out, 'NATIVE-VALUE')
    assert.notInclude(out, 'H37Rv')
  })

  it('returns nothing for an unknown field rather than throwing', function () {
    assert.doesNotThrow(() => header(['no_such_field']))
  })
})
