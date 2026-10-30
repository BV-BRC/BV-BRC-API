# Join Enrichment API

The BV-BRC data API supports augmenting query results with fields from related collections via a post-query enrichment system. This is triggered by the client requesting fields that belong to a related collection, not to the queried collection itself.

## How to use it (client-side)

Include fields from a related collection in your `select()` or `fl=` parameter. The API detects which fields are "joinable" and automatically fetches them from the source collection after the primary query completes.

**Example:** Query genome_feature but include `genome_name` (which lives in the genome collection):

```
GET /genome_feature/?eq(genome_id,12345.6)&select(feature_id,patric_id,product,genome_name)
```

`genome_name` is not a field in genome_feature — it's in the genome collection. The API:
1. Runs the genome_feature query returning `feature_id`, `patric_id`, `product`, and `genome_id` (the join key, injected automatically)
2. Collects the unique `genome_id` values from the results
3. Batch-fetches `genome_name` from the genome collection for those genome_ids
4. Merges the genome_name into each result document
5. Returns the enriched documents to the client

## Discovering what a collection can return

**`GET /:collection/fields`** reports every field a collection can return — native and
enriched — with a readable label and a `source` flag. Prefer it over hardcoding a list:
it reads the same registry the enrichment middleware uses, so it cannot drift from what
enrichment will actually do.

```
GET /genome_feature/fields
{
  "collection": "genome_feature",
  "fields": [
    { "name": "feature_id", "label": "Feature ID", "source": "native",
      "type": "string", "multiValued": false },
    { "name": "host_name",  "label": "Host Name",  "source": "enriched",
      "from": "genome", "via": "genome_id", "hops": 1 }
  ],
  "counts": { "total": 81, "native": 46, "enriched": 35 }
}
```

Two things it deliberately does:

- **Unstored fields are omitted.** They are indexed and filterable but can never be
  returned, so offering one as a selectable column produces a permanently empty column
  (`genome.collection_date_dr` is exactly this).
- **A field that is both native and joinable is listed once, as native** — the native
  value wins, so showing a choice would be misleading.

Labels are **derived** from field names, with a small override table for the cases
derivation mangles (`genome_id` → "Genome ID", `patric_id` → "BRC ID"). There is no
curated label source in the codebase; see `lib/fieldLabels.js` for why, and for where a
curated set would plug in.

## Joinable fields by collection

Configured in **`lib/joinConfig.js`** (overridable via `joinEnrichment` in `p3api.conf`).

> **Add joinable fields in `lib/joinConfig.js`, never in `config.js`.** A
> `joinEnrichment` default declared in `config.js` is indistinguishable from an
> operator's override and silently replaces the module defaults entirely — a second copy
> lived there until 2026-10-30 and meant that adding a field to `lib/joinConfig.js` had
> no effect at all. A regression test now pins that `config.js` declares no default.

All six genome-keyed collections expose the **same 37 fields** from `genome` via
`genome_id`:

| Source collection | Joined from | Via key | Fields |
|---|---|---|---|
| genome_feature | genome | genome_id | the shared 35, plus `genome_name`, `taxon_id` |
| genome_sequence | genome | genome_id | same |
| pathway | genome | genome_id | same |
| subsystem | genome | genome_id | same |
| sp_gene | genome | genome_id | same |
| genome_amr | genome | genome_id | same |

The shared set (`GENOME_METADATA_FIELDS` in `lib/joinConfig.js`):

```
strain, genome_status
isolation_source, isolation_comments, collection_date, collection_year, season
isolation_country, state_province, county, city, geographic_group,
  geographic_location, other_environmental
host_name, host_common_name, host_scientific_name, host_gender, host_age,
  host_health, host_group, lab_host, passage, other_clinical
phenotype, gram_stain, cell_shape, motility, sporulation, temperature_range,
  optimal_temperature, salinity, oxygen_requirement, habitat
disease
```

**`genome` itself has no join config, and that is correct** — its own fields already
include all of this, so a `genome`→`genome` join would be a no-op and would list every
field twice.

**Deprecated fields are deliberately excluded**: `isolation_site`, `latitude`,
`longitude`, `altitude`, `depth`, `body_sample_site`, `body_sample_subsite`,
`antimicrobial_resistance`, `antimicrobial_resistance_evidence`. Exposing them would
advertise as current a surface that is being retired. `collection_date_dr` is also
absent — it is `stored="false"`, so Solr cannot return it.

**Cost of the field count is near zero.** All of these share `from`+`via`, so
`buildJoinSpecs` groups them into **one** lookup however many are requested, and the
`fl` sent to Solr lists only the fields actually asked for.

## How it works internally

### Middleware chain position

```
JoinFieldInjector  →  injects genome_id into fl=, sets req._joinSpecs
DistributedQuery   →  (if distributed) creates stream, pipes through JoinEnrichmentStream
checkIfStreaming   →  converts call_method from 'query' to 'stream' for downloads
APIMethodHandler   →  (if non-distributed stream) pipes through JoinEnrichmentStream
                      (if paginated query) returns in-memory results
JoinEnrichment     →  (paginated queries only) enriches in-memory docs array
media              →  serializes enriched results (JSON, CSV, TSV, etc.)
```

### Component details

1. **`JoinFieldInjector` middleware** (runs before the Solr query): Detects that joinable fields were requested and injects the join key field (e.g., `genome_id`) into the `fl=` field list so the primary query returns it. Also builds join specifications and stores them on `req._joinSpecs` for downstream middleware.

2. **`JoinEnrichment` middleware** (runs after the Solr query, before media serialization): For paginated queries (`call_method === 'query'`), parses the requested fields, identifies which are joinable, groups them by target collection, and uses `BatchJoiner` to fetch and merge the data in-memory.

3. **`JoinEnrichmentStream`** (`lib/distributed/JoinEnrichmentStream.js`): A Transform stream for streaming enrichment. Buffers incoming documents into configurable-size batches, uses `BatchJoiner` to fetch joined fields, and pushes enriched documents downstream. Used by both `DistributedQuery` and `APIMethodHandler` when `req._joinSpecs` is present on streaming requests. Degrades gracefully on errors (pushes unenriched docs).

4. **`BatchJoiner`** (`lib/BatchJoiner.js`): Performs batched lookups against the target collection using `DirectSolrClient` (direct shard access, not through the coordinator). Includes an LRU cache (default 200 entries) so repeated genome_id lookups within the same request or across requests are fast. Shared across both paginated and streaming paths via `getJoiner()` singleton.

## Response headers

When enrichment is performed, the API sets response headers:
- `X-Join-Enrichment: true` — enrichment was performed
- `X-Join-Fields: genome_name,taxon_id` — which fields were joined
- `X-Join-Time-Ms: 45` — time spent on enrichment

If enrichment fails, results are returned unenriched (no error status) with `X-Join-Enrichment: error`.

## Streaming enrichment

Join enrichment works for both paginated queries and streaming downloads. The path taken depends on the request type:

- **Paginated queries** (`call_method === 'query'`): `JoinEnrichment` middleware enriches the in-memory `res.results.response.docs` array after the query completes.
- **Streaming downloads** (via `http_download=true` or large limits): `JoinEnrichmentStream` is piped into the stream pipeline between the Solr result stream and the media serializer. This applies to both the distributed query path and the standard Solrjs streaming path.

The streaming path buffers documents into batches (default 50), enriches each batch via `BatchJoiner`, and pushes enriched documents downstream. Backpressure is handled by the Transform stream's built-in highWaterMark mechanism.

**Example — streaming download with enrichment:**

```
GET /genome_feature/?eq(genome_id,12345.6)&select(feature_id,product,genome_name)&limit(2500000)&http_download=true
Accept: text/csv
```

This streams 2.5M features as CSV with `genome_name` enriched from the genome collection inline during streaming.

### Debug output

```bash
# Debug streaming join enrichment
DEBUG=p3api-server:distributed:join-enrichment-stream npm start

# Combined with distributed query debugging
DEBUG=p3api-server:distributed:*,p3api-server:middleware/DistributedQuery npm start
```

## FASTA downloads: header fields and formatting

FASTA headers can carry enriched fields, and the field names are the **same bare names**
`/:collection/fields` reports — `host_name`, not `genome_metadata.host_name`. The
prefixed form still works as an alias so existing saved URLs keep functioning, but bare
is canonical and consistent with `select()`.

Requesting an enriched field in a header is what triggers the genome join; there is no
separate switch.

### Zone parameters (the default scheme)

```
>«id_prefix»ID1«id_delim»ID2«id_delim» DESC1«desc_delim»DESC2 [CTX1«ctx_delim»CTX2]
```

| parameter | default | controls |
|---|---|---|
| `http_fasta_id_fields` | per-collection | fields in the ID zone |
| `http_fasta_id_delimiter` | `\|` | between ID fields, **and appended as a trailing character** |
| `http_fasta_id_prefix` | `''` (`accn\|` for genome_sequence) | literal prefix |
| `http_fasta_description_fields` | per-collection | description zone |
| `http_fasta_description_delimiter` | `' '` (single space) | between description fields |
| `http_fasta_context_fields` | per-collection | the bracketed `[...]` zone |
| `http_fasta_context_delimiter` | `' \| '` (spaces included) | between context fields |

**An empty value is skipped entirely** — no placeholder, and no stray delimiter. A zone
whose fields all resolve empty is omitted along with its brackets. That is why a missing
field looks like nothing rather than a gap.

### Format strings (`http_fasta_header`)

When the zone scheme cannot express the required layout, supply a template:

```
http_fasta_header={patric_id}|{genome_id} {product} [{genome_name}]
  -> >fig|1.1.peg.1|1.1 ABC transporter [E. coli K-12]

http_fasta_header=db|{genome_id}|{patric_id}::{host_name}
  -> >db|1.1|fig|1.1.peg.1::Homo sapiens
```

Four behaviours, each chosen deliberately:

1. **A missing value renders empty and the template is NOT rewritten around it.**
   `{patric_id}|{strain}|{product}` with no strain gives `>fig|1.1.peg.1||ABC transporter`
   — the delimiters stay. The zone scheme collapses them; a template cannot without
   inventing conditional syntax. **If you need omit-when-absent, use the zone
   parameters.**
2. **It is exclusive.** When `http_fasta_header` is present the zone parameters are
   ignored entirely, including for deciding which fields to join.
3. **`{{` and `}}` are literal braces.** `A{{x}}B` → `>A{x}B`; `{{{patric_id}}}` →
   `>{fig|1.1.peg.1}`, i.e. a literal brace followed by a real reference.
4. **Syntax errors are rejected with 400 before the response starts** — unbalanced
   braces, an empty `{}`, an empty template. This matters because an unbalanced brace is
   not a partial failure: the raw template text lands in every header in the file.

> **An unknown FIELD NAME is NOT rejected — it renders empty and returns 200.**
>
> `{hostname}` (a typo of `host_name`) produces a silently truncated header, not an
> error. Validating a bare name needs the collection's Solr schema, and fetching it
> would add a round trip to every templated download for a check a client can make once.
>
> **So validating template field names against `/:collection/fields` is load-bearing
> for any client, not a nicety.** Nothing server-side will catch a typo. Syntax errors
> *are* caught, because checking them needs nothing but the string.

### What formatting does not do

**There is no quoting or escaping.** Values are interpolated verbatim in both schemes,
so:

- a value containing your delimiter is indistinguishable from a field boundary —
  `host_name` is literally `"Human, Homo sapiens"`, so commas are already common;
- a value containing a newline **would corrupt the record**, since the next line is read
  as sequence data.

Treat the header as display text. If you need to round-trip structured values, request
CSV or JSON, whose serializers quote properly. If a header must be machine-parsed,
choose a delimiter that cannot occur in the data and understand that it is a convention,
not a guarantee.

## Limitations

- All current joins are from other collections → genome collection via `genome_id`. The system is designed to be extensible to other join patterns.
- The joinable fields must be explicitly configured — arbitrary cross-collection field requests are not supported.
- FASTA serializers have their own separate enrichment streams (`SequenceJoinStream`, `GenomeMetadataJoinStream`) that predate the generic system. They now resolve which fields to fetch through the shared registry (`lib/fastaGenomeFields.js`), so they no longer diverge from what `/:collection/fields` advertises — but the transport is still separate.
- No quoting or escaping in FASTA headers; see "What formatting does not do" above.

## Key files

- `middleware/JoinFieldInjector.js` — Injects join key fields into the Solr query field list; sets `req._joinSpecs`
- `middleware/JoinEnrichment.js` — Post-query enrichment for paginated queries
- `lib/distributed/JoinEnrichmentStream.js` — Transform stream for streaming enrichment
- `lib/BatchJoiner.js` — Batched lookup and enrichment engine with LRU cache
- `lib/parseFieldList.js` — Parses `fl=` / `select()` to identify requested join fields
- `lib/distributed/DirectSolrClient.js` — Direct shard access for batch lookups
- `lib/joinConfig.js` — **The joinable-field registry.** Add fields here, not in `config.js`
- `lib/collectionFields.js` — Builds the `/:collection/fields` payload
- `lib/fieldLabels.js` — Readable labels (derived, with an override table)
- `lib/fastaGenomeFields.js` — Resolves which genome fields a FASTA request needs
- `util/fastaHeaderFormatter.js` — Header assembly: zones, delimiters, format strings
