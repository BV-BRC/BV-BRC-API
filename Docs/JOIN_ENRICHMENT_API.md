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

## Joinable fields by collection

Configured in `middleware/JoinEnrichment.js` (and overridable via `joinEnrichment` in `p3api.conf`):

| Source collection | Joinable fields | Joined from | Via key |
|---|---|---|---|
| genome_feature | genome_name, taxon_id, genome_status, strain | genome | genome_id |
| pathway | genome_name, taxon_id | genome | genome_id |
| subsystem | genome_name, taxon_id | genome | genome_id |
| sp_gene | genome_name, taxon_id | genome | genome_id |
| genome_amr | genome_name, taxon_id | genome | genome_id |

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

## Limitations

- All current joins are from other collections → genome collection via `genome_id`. The system is designed to be extensible to other join patterns.
- The joinable fields must be explicitly configured — arbitrary cross-collection field requests are not supported.
- FASTA serializers have their own separate enrichment streams (`SequenceJoinStream`, `GenomeMetadataJoinStream`) that predate the generic system.

## Key files

- `middleware/JoinFieldInjector.js` — Injects join key fields into the Solr query field list; sets `req._joinSpecs`
- `middleware/JoinEnrichment.js` — Post-query enrichment for paginated queries
- `lib/distributed/JoinEnrichmentStream.js` — Transform stream for streaming enrichment
- `lib/BatchJoiner.js` — Batched lookup and enrichment engine with LRU cache
- `lib/parseFieldList.js` — Parses `fl=` / `select()` to identify requested join fields
- `lib/distributed/DirectSolrClient.js` — Direct shard access for batch lookups
