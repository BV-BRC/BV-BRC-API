/**
 * Describe the fields a collection can return — native and join-enriched.
 *
 * Serves `GET /:collection/fields`, which exists so the website can build a column
 * picker without hardcoding a field list that drifts from the API. Before this, the only
 * way to know a collection could be enriched with `host_name` was to read
 * `lib/joinConfig.js`.
 *
 * ON READABLE NAMES: there is no authoritative label source in this codebase, and the
 * places one might expect to find it do not have it. See lib/fieldLabels.js for the
 * evidence and for why labels are derived rather than curated.
 *
 * WHAT A FIELD IS GOOD FOR. Every entry carries four flags — `returnable`,
 * `filterable`, `sortable`, `facetable` — because "the collection has this field" does
 * not mean "you can query on it":
 *
 * - Enriched fields are attached AFTER the query to the returned page, so they are
 *   returnable and nothing else. `/genome_feature/fields` lists `segment`, and
 *   `eq(segment,4)` on genome_feature is a 400. A client building a filter UI must use
 *   `filterable`, not `source` — and must not hardcode a list, which is what this
 *   endpoint exists to prevent.
 * - Native fields are resolved field → fieldType → Solr default, because the schema API
 *   omits defaulted properties (`docValues` normally lives on the type).
 * - Unreturnable native fields (`collection_date_dr` on `genome`: indexed, unstored, no
 *   docValues) are filterable but would be a permanently empty column, so the default
 *   payload omits them; `?all=true` includes them with `returnable: false`.
 *
 * Joinable fields come from the join configuration, which is the same source
 * `JoinFieldInjector` and `JoinEnrichment` read, so the endpoint cannot disagree with
 * what enrichment will actually do.
 */

const { getJoinConfig } = require('./joinConfig')
const { fieldLabel } = require('./fieldLabels')
const CacheManager = require('./distributed/CacheManager')

// Schemas change only on a Solr reload, so a long TTL is safe and the point is to keep
// strict validation off the per-request critical path: without it every strict download
// pays a schema fetch, which is exactly the cost that kept field-name checking out of
// the default path.
const SCHEMA_TTL_MS = 10 * 60 * 1000
const schemaCache = new CacheManager({ ttlMs: SCHEMA_TTL_MS, name: 'collection-fields-schema' })

// Solr's own defaults for schema version 1.6 — what applies when neither the field nor
// its fieldType says otherwise. The schema API omits defaulted properties, so a field
// with no `docValues` key usually inherits it from its type (alpha's `string` and every
// point type set it there) and only falls through to these when the type is silent too.
const SOLR_DEFAULTS = {
  indexed: true,
  stored: true,
  docValues: false,
  multiValued: false,
  uninvertible: true,
  useDocValuesAsStored: true
}

// Per-class defaults that override SOLR_DEFAULTS. SortableTextField implies docValues
// (and does not read them back as stored); taxonomy's `string_ci` type relies on this —
// it declares no docValues, and sort(+other_names), a multiValued field, still works.
const CLASS_DEFAULTS = {
  'solr.SortableTextField': { docValues: true, useDocValuesAsStored: false }
}

// Classes whose values are tokenized: you can search them, but sorting is an error and
// a facet counts tokens rather than values, which is never what a picker means.
const TOKENIZED_CLASSES = new Set(['solr.TextField'])
// Classes that can be filtered on but not sorted or faceted by value.
const UNSORTABLE_CLASSES = new Set(['solr.DateRangeField', 'solr.RandomSortField'])

/**
 * What a client may do with a native field, resolved field → fieldType → class default →
 * Solr default.
 *
 * - returnable: stored, or docValues read back as stored (useDocValuesAsStored).
 * - filterable: indexed, or docValues (Solr can query docValues-only fields, slowly).
 * - sortable:   value-typed, and docValues (multiValued sorts by min asc / max desc —
 *               verified live on genome_feature.go) or single-valued uninvertible-indexed.
 * - facetable:  value-typed, and docValues or uninvertible-indexed.
 *
 * These mirror Solr's rules closely enough for a UI to choose controls. They are not a
 * guarantee — Solr is the final word, and a query against it still decides.
 */
function nativeCapabilities (field, fieldType) {
  const cls = fieldType && fieldType.class
  const prop = (k) => {
    if (field[k] !== undefined) return field[k]
    if (fieldType && fieldType[k] !== undefined) return fieldType[k]
    const byClass = CLASS_DEFAULTS[cls]
    if (byClass && byClass[k] !== undefined) return byClass[k]
    return SOLR_DEFAULTS[k]
  }
  const indexed = prop('indexed') === true
  const docValues = prop('docValues') === true
  const multiValued = prop('multiValued') === true
  const uninverted = indexed && prop('uninvertible') === true
  const valueAccess = docValues || uninverted
  const valueTyped = !TOKENIZED_CLASSES.has(cls) && !UNSORTABLE_CLASSES.has(cls)

  return {
    multiValued,
    returnable: prop('stored') === true || (docValues && prop('useDocValuesAsStored') === true),
    filterable: indexed || docValues,
    sortable: valueTyped && (docValues || (uninverted && !multiValued)),
    facetable: valueTyped && valueAccess
  }
}

// Enriched fields are attached after the query, to the returned page only
// (JoinEnrichment / JoinEnrichmentStream). Solr never sees them, so they can be
// returned and nothing else — `/genome_feature/?eq(segment,4)` is a 400
// "undefined field segment". Filtering by a genome attribute goes through
// `genome(eq(segment,4))` instead.
const ENRICHED_CAPABILITIES = Object.freeze({
  returnable: true,
  filterable: false,
  sortable: false,
  facetable: false
})

/**
 * Build the field description for one collection.
 *
 * @param {string} collection
 * @param {Object} schema - Parsed Solr schema response (`{ schema: { fields, fieldTypes } }`
 *   or `{ fields, fieldTypes }`)
 * @param {Object} [opts]
 * @param {boolean} [opts.includeUnreturnable=false] - also list native fields that can
 *   be filtered on but not returned (flagged `returnable: false`). OFF by default
 *   because existing consumers treat every entry as a selectable column, and such a
 *   field would be a permanently empty one.
 * @returns {Object} `{ collection, fields: [...], counts: {...} }`
 */
function describeFields (collection, schema, opts = {}) {
  const root = (schema && schema.schema) || schema || {}
  const rawFields = Array.isArray(root.fields) ? root.fields : []
  const fieldTypes = new Map(
    (Array.isArray(root.fieldTypes) ? root.fieldTypes : [])
      .filter((t) => t && t.name)
      .map((t) => [t.name, t])
  )

  const fields = []
  const seen = new Set()

  for (const f of rawFields) {
    if (!f || !f.name) continue
    // Solr's internal bookkeeping field; never useful to a client.
    if (f.name === '_version_') continue
    // Dynamic-field patterns are templates, not fields.
    if (f.name.includes('*')) continue

    const caps = nativeCapabilities(f, fieldTypes.get(f.type))
    // A field that cannot be RETURNED yields a permanently empty column, so it is
    // listed only on request. It is still a real field: claim the name either way,
    // so a same-named join cannot be advertised in its place.
    seen.add(f.name)
    if (!caps.returnable && !opts.includeUnreturnable) continue

    fields.push({
      name: f.name,
      label: fieldLabel(f.name),
      source: 'native',
      type: f.type,
      ...caps
    })
  }

  // Joinable fields, from the same config the enrichment middleware reads.
  const joinConfig = getJoinConfig()
  const collectionConfig = (joinConfig.collections || {})[collection]
  const joinableFields = (collectionConfig && collectionConfig.joinableFields) || {}

  for (const [name, spec] of Object.entries(joinableFields)) {
    // A joinable field that is ALSO native would be shadowed by the native value;
    // report it once, as native, rather than implying a choice that does not exist.
    if (seen.has(name)) continue

    const multiHop = Array.isArray(spec.path) && spec.path.length > 0
    const from = multiHop ? spec.path[0].from : spec.from
    const via = multiHop ? spec.path[0].localField : spec.via

    fields.push({
      name,
      label: fieldLabel(name),
      source: 'enriched',
      from,
      via,
      hops: multiHop ? spec.path.length : 1,
      ...ENRICHED_CAPABILITIES
    })
  }

  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    collection,
    fields,
    counts: {
      total: fields.length,
      native: fields.filter((f) => f.source === 'native').length,
      enriched: fields.filter((f) => f.source === 'enriched').length,
      filterable: fields.filter((f) => f.filterable).length
    }
  }
}

/**
 * Names a collection can return: native (stored) plus joinable.
 *
 * @param {string} collection
 * @param {Object} schema - parsed Solr schema response
 * @returns {Set<string>}
 */
function knownFieldNames (collection, schema) {
  // Default describeFields() lists only returnable fields, which is what strict
  // download validation means by "known": a filter-only field in a template would
  // render empty. Do not pass includeUnreturnable here.
  return new Set(describeFields(collection, schema).fields.map((f) => f.name))
}

/**
 * Validate field names against a collection, fetching and caching its schema.
 *
 * Only called for requests that OPT IN to strict mode. That is what makes it
 * affordable: the unconditional version would add a schema fetch to every templated
 * download, which is why field-name checking is not in the default path.
 *
 * @param {string} collection
 * @param {Array<string>} names
 * @param {Function} fetchSchema - async () => parsed schema
 * @returns {Promise<Array<string>>} the unknown names, empty when all are valid
 */
async function findUnknownFields (collection, names, fetchSchema) {
  const wanted = (names || []).filter((n) => n && !n.includes('.'))
  if (wanted.length === 0) return []

  let schema = schemaCache.get(collection)
  if (schema === undefined) {
    schema = await fetchSchema()
    if (schema && typeof schema === 'string') schema = JSON.parse(schema)
    schemaCache.set(collection, schema)
  }

  const known = knownFieldNames(collection, schema)
  return wanted.filter((n) => !known.has(n))
}

module.exports = {
  describeFields,
  nativeCapabilities,
  knownFieldNames,
  findUnknownFields,
  schemaCache
}
