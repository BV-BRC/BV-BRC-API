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
 * A note on what "available" means here. Native fields are reported from the live Solr
 * schema, filtered to `stored` — an unstored field is indexed and filterable but **cannot
 * be returned**, so offering it in a column picker would produce a permanently empty
 * column. (`collection_date_dr` on `genome` is exactly this.) Joinable fields come from
 * the join configuration, which is the same source `JoinFieldInjector` and
 * `JoinEnrichment` read, so the endpoint cannot disagree with what enrichment will
 * actually do.
 */

const { getJoinConfig } = require('./joinConfig')
const { fieldLabel } = require('./fieldLabels')

/**
 * Build the field description for one collection.
 *
 * @param {string} collection
 * @param {Object} schema - Parsed Solr schema response (`{ schema: { fields: [...] } }`
 *   or `{ fields: [...] }`)
 * @returns {Object} `{ collection, fields: [...], counts: {...} }`
 */
function describeFields (collection, schema) {
  const rawFields = (schema && schema.schema && schema.schema.fields) ||
                    (schema && schema.fields) ||
                    []

  const fields = []
  const seen = new Set()

  for (const f of rawFields) {
    if (!f || !f.name) continue
    // Solr's internal bookkeeping field; never useful to a client.
    if (f.name === '_version_') continue
    // Dynamic-field patterns are templates, not fields.
    if (f.name.includes('*')) continue
    // Unstored fields cannot be RETURNED, only filtered on. Offering one as a
    // selectable column yields a permanently empty column.
    if (f.stored === false) continue

    seen.add(f.name)
    fields.push({
      name: f.name,
      label: fieldLabel(f.name),
      source: 'native',
      type: f.type,
      multiValued: f.multiValued === true
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
      hops: multiHop ? spec.path.length : 1
    })
  }

  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    collection,
    fields,
    counts: {
      total: fields.length,
      native: fields.filter((f) => f.source === 'native').length,
      enriched: fields.filter((f) => f.source === 'enriched').length
    }
  }
}

module.exports = { describeFields }
