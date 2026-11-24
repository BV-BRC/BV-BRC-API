/**
 * http_fasta_strict — opt-in rejection of unknown template field names.
 *
 * By default a typo in a format string renders empty and returns 200: `{hostname}` for
 * host_name produces a silently truncated header. That bit a GUI client, and it stays
 * the default because validating a bare name needs the collection's Solr schema and
 * fetching it unconditionally would tax every templated download.
 *
 * Strict mode makes the caller pay for the check they want. The schema is cached, so
 * even a strict caller rarely pays it.
 *
 * Offline: findUnknownFields takes the schema fetcher as a parameter.
 */

const assert = require('chai').assert
const { findUnknownFields, knownFieldNames, schemaCache } = require('../../lib/collectionFields')

const SCHEMA = {
  schema: {
    fields: [
      { name: 'patric_id', type: 'string', stored: true },
      { name: 'product', type: 'string', stored: true },
      { name: 'secret_internal', type: 'string', stored: false }
    ]
  }
}

const fetcher = (schema = SCHEMA) => {
  const calls = { n: 0 }
  const fn = async () => { calls.n++; return schema }
  fn.calls = calls
  return fn
}

describe('strict FASTA template field validation', function () {
  beforeEach(function () { schemaCache.clear && schemaCache.clear() })

  it('accepts native fields', async function () {
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['patric_id', 'product'], fetcher()), [])
  })

  it('accepts JOINABLE fields, which are not in the Solr schema', async function () {
    // The whole point of checking against describeFields() rather than the raw schema:
    // host_name is enriched, so a schema-only check would reject a valid template.
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['host_name', 'habitat'], fetcher()), [])
  })

  it('REJECTS the reported typo', async function () {
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['patric_id', 'hostname'], fetcher()),
      ['hostname'])
  })

  it('reports every unknown name, not just the first', async function () {
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['nope', 'patric_id', 'alsonope'], fetcher()),
      ['nope', 'alsonope'])
  })

  it('rejects an UNSTORED field — it can never be returned', async function () {
    // Consistent with /:collection/fields, which omits unstored fields because they
    // would be permanently empty columns.
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['secret_internal'], fetcher()),
      ['secret_internal'])
  })

  it('skips dotted paths rather than guessing at nesting', async function () {
    // genome_metadata.host_name addresses an attached object, not a registry entry.
    assert.deepEqual(
      await findUnknownFields('genome_feature', ['genome_metadata.host_name'], fetcher()), [])
  })

  it('does not fetch a schema when there is nothing to check', async function () {
    const f = fetcher()
    assert.deepEqual(await findUnknownFields('genome_feature', [], f), [])
    assert.equal(f.calls.n, 0, 'no schema fetch for an empty field list')
  })

  it('caches the schema across calls', async function () {
    // Without this, strict mode taxes every request -- the cost that kept field
    // checking out of the default path in the first place.
    const f = fetcher()
    await findUnknownFields('genome_feature', ['patric_id'], f)
    await findUnknownFields('genome_feature', ['product'], f)
    assert.equal(f.calls.n, 1, 'second call must hit the cache')
  })

  it('parses a schema delivered as a JSON string', async function () {
    const f = async () => JSON.stringify(SCHEMA)
    assert.deepEqual(await findUnknownFields('genome_feature', ['patric_id'], f), [])
  })

  it('propagates a fetch failure so the caller can decide', async function () {
    // The route guard FAILS OPEN on this: strict mode catches typos, it is not a
    // security control, so a Solr blip must not 400 a valid download.
    const boom = async () => { throw new Error('solr down') }
    try {
      await findUnknownFields('genome_feature', ['patric_id'], boom)
      assert.fail('expected the error to propagate')
    } catch (e) {
      assert.include(e.message, 'solr down')
    }
  })

  describe('knownFieldNames', function () {
    it('unions native and joinable', function () {
      const names = knownFieldNames('genome_feature', SCHEMA)
      assert.isTrue(names.has('patric_id'), 'native')
      assert.isTrue(names.has('host_name'), 'joinable')
      assert.isFalse(names.has('secret_internal'), 'unstored')
    })

    it('returns only joinable names when the schema is unavailable', function () {
      const names = knownFieldNames('genome_feature', {})
      assert.isTrue(names.has('host_name'))
      assert.isFalse(names.has('patric_id'))
    })
  })
})
