# PLAN — Private metadata overlay on the genome collection (display, filter, facet)

**Status:** sketch, for vetting. Not costed against a real schema — the override collection
does not exist yet.
**Related:** `PLAN_GENOME_POSTFILTER.md` (JS-side post-filtering precedent),
`PLAN_CROSS_COLLECTION_DOWNLOAD.md` (multi-hop join + permission scoping),
`Docs/JOIN_ENRICHMENT_API.md`, `lib/permissionFilter.js`, `lib/BatchJoiner.js`.

---

## Problem

A new private collection stores per-user metadata about genomes. Its fields **override** the
corresponding `genome` fields where they overlap, and it also carries **additional** fields
that do not exist in `genome` at all. Users must see, filter on, and facet over the merged
view — the overridden value, not the public one.

### Given constraints (2026-08-20)

| | |
|---|---|
| genomes carrying overrides | **hundreds** |
| overridden/additional fields | **~10–12**, of which some are additive-only |
| different users overriding the *same* genome | **possible, unconfirmed** — design for it, do not gate on it |

The scale is what makes this tractable. Hundreds of override records fit comfortably in
memory, which means the merge can happen API-side and never needs Solr to join anything.

---

## Why the existing machinery does not solve it

Three near-misses, each worth stating so nobody re-derives them:

- **`JoinEnrichment` is post-query and page-scoped.** It decorates
  `res.results.response.docs` — the 25 rows being returned (`middleware/JoinEnrichment.js:109`).
  Solr computed the facet counts over the *entire* matched DocSet before that middleware ran,
  so anything enrichment changes is invisible to the counts.
- **`{!join fromIndex=…}` filters, it does not project.** It can restrict *which* genome docs
  match; it cannot change the field *values* Solr counts. An overridden value simply is not in
  the index being faceted.
- **Facets bypass the distributed path entirely** (`middleware/DistributedQuery.js:171` returns
  `useDistributed: false` for `facet=true`/`group=true`), so there is no streaming hook to
  intercept either.

Net: **facet counts cannot be corrected inside Solr.** They must be corrected arithmetically,
after the fact, by the API.

---

## Three capabilities, increasing difficulty

Treat these separately — they have different costs and the first may be all that is wanted.

### 1. Display (cheap)

Merge override values into returned rows. This is exactly the shape `JoinEnrichment` already
has: fetch by `genome_id`, merge fields, respect permission scope. Additive fields work here
for free — they are just extra keys on the doc.

**Effort: small.** Mostly a new join spec plus the merge direction (override wins).

### 2. Facet correction (moderate — the real work)

Because the override set is small, the correction is exact arithmetic, not an estimate:

1. Fetch **all** of this user's override records — one Solr query, permission-scoped,
   cacheable per user. Hundreds of docs.
2. Run the user's faceted query against `genome` as normal.
3. Run a **second** faceted query narrowed to just the overridden IDs, via
   `{!terms f=genome_id}…` — the hash-filter path already emitted by `lib/solrjs/rql.js:472`
   and used to replace broad joins. This yields each overridden genome's **public** values.
4. For each faceted field: `corrected = main − public_of_overridden + override_values`.

Exact because step 1 returns the complete override set, not a sample. Hundreds of IDs is well
inside what `{!terms}` handles — that operator exists precisely for this.

Solr returns `facet_counts.facet_fields.<field>` as a flat `[value, count, value, count, …]`
array, or as a map with `json.nl=map` (see `routes/dataRouter.js:60,65`). Normalise to a map,
do the arithmetic, serialise back in whatever shape the request asked for.

**Effort: moderate.** The arithmetic is trivial; the growth is in field-type handling —
multi-valued fields (one genome contributes to several buckets), `facet.range`, `facet.pivot`,
`facet.mincount` interactions, and buckets that reach zero and must disappear.

### 3. Filtering on additive fields (largest — defer unless needed)

Overridden fields can be filtered normally (the field exists in `genome`; only the value is
wrong, and step 2's machinery can reconcile). **Additive** fields cannot — Solr cannot match on
a field absent from the index. Two options, both with precedent:

- **Prefilter:** resolve matching `genome_id`s from the override collection, constrain the
  genome query with `{!terms f=genome_id}`. Clean while the ID set stays small.
- **Post-filter:** the approach in `PLAN_GENOME_POSTFILTER.md` — run the main query, filter in
  JS, trim to the page window. The `rql` package ships `js-array` with a working JS-side
  evaluator (`require('rql/js-array').query('eq(host_name,Human)', {}, docs)` — verified), so
  the building block exists.

Post-filtering and correct facet counts fight each other: if JS drops rows after Solr counted
them, the facets describe a different set than the rows. Pick one story and test it.

**Effort: largest.** Recommend deferring.

---

## Design decisions

### Build per-user from the start

The multi-user-override case is unconfirmed but **costs almost nothing to support now and is
painful to retrofit.** The override fetch is permission-scoped, so it already returns *this
user's* rows; everything downstream is per-request arithmetic over that set. Designing for it
makes the multi-user question a data question rather than a rework.

### Scope-key every cache — this is the known failure mode

The override set is an obvious cache candidate and has **exactly the shape of the bug fixed on
2026-08-06**. `BatchJoiner`'s LRU keys on `${scopeKey} ${value}` because it is a process-wide
singleton: an unscoped key serves one user's private row to the next, and a fetch-only fix
still leaks from a warm cache.

Use `permissionContext({ collection, user, publicFree })` from `lib/permissionFilter.js` and
key on the returned `scopeKey`. The override collection is **not** `publicFree`, so it needs
its *own* context — do not reuse the genome `fq`. Same rule the multi-hop
`enrichDocsChained` follows: each hop resolves permissions against its own target collection.

### Additive-field faceting needs a product decision

Only the hundreds of overridden genomes have a value for an additive field; the other ~2M have
nothing. So `facet(my_custom_field)` is really "facet over the override collection alone" —
cheap and exact, but **what do the missing millions mean?** A `__missing__` bucket, or
excluded? Get this wrong and facet counts stop summing to the result count.

---

## Non-negotiables

Every bug in the comparable features here produced a plausible-looking **HTTP 200 with wrong
data**. Assert on exact counts.

- **Facet counts must sum consistently with `Content-Range`.** A mismatch is the silent
  failure. The merge gate should be a fixture where an override *moves* a genome from one
  bucket to another — a test that passes when the correction is skipped is not testing it.
- **Cross-user cache test**, in the shape of
  `tests/test-permissions/test.enrichment-permissions.spec.js`. It must fail against a
  fetch-only implementation.
- **Multi-valued fields**: one genome can contribute to several buckets, so subtract *all* its
  public values, not one.
- **Zeroed buckets** must be removed, not left at 0, or they leak the existence of private data.
- **Test against live Solr, not mocks.** Per the record in `PLAN_CROSS_COLLECTION_DOWNLOAD.md`,
  four of six bugs in that feature were only findable over real HTTP.

---

## Middleware placement

Correction runs **after** `APIMethodHandler` (facets must exist) and **before** `media`
(serialisers read `res.results.facet_counts`, e.g. `media/json.js:32`). Alongside
`JoinEnrichment` in the `routes/dataType.js` chain (line 282), and inert unless the request
both facets and touches an overlaid field.

---

## Rejected alternatives

| approach | why not |
|---|---|
| **Denormalise overrides into the `genome` index** | Native faceting, no join, works with the distributed path — but puts private data in the public index, colliding with the `publicFree`/permission model. Every query would need the override fields permission-scoped, and one mistake leaks. Reconsider only if overrides grow far beyond hundreds. |
| **Solr streaming expressions (`innerJoin` + `facet`)** | A different execution engine from the `/select` path the whole middleware chain uses, with its own performance profile and no integration. Not worth it at this scale. |
| **Nightly materialised merged collection** | Cheapest at query time, but stale, and adds an index to sync *and* permission-scope. Viable if per-user overrides turn out **not** to be a requirement; dead if they are. |

---

## Open questions

1. **Is faceting actually required, or would display + filtering do?** Display is the cheap
   enrichment-shaped path. Faceting is what forces all the count arithmetic. Worth confirming
   before building capability 2.
2. Do overridden fields need to be **sortable** on the merged value? Sorting has the same
   in-index problem as faceting and is not addressed above.
3. Which of the ~10–12 fields are additive vs overriding, and are any **multi-valued**?
4. Should an override be visible to anyone but its owner (shared/group overrides)?
5. What is the override collection's uniqueKey — `(genome_id, owner)`? That determines whether
   "different users override the same genome" is even representable.

---

## Rough effort

Assumes the override collection exists and is indexed.

| piece | size |
|---|---|
| Override fetch + per-user scope-keyed cache | small — mirrors `BatchJoiner` |
| Display merge | small |
| Facet correction, override fields | moderate — arithmetic simple, field types grow it |
| Facet handling, additive fields | moderate — mostly semantics |
| Filtering on additive fields | largest — defer |
| Tests (count assertions + cross-user cache) | not optional |

**A few days for display + override-field faceting.** Longer with additive filtering, and the
open questions above could move it either way.
