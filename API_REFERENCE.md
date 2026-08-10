# BV-BRC API Reference

This document provides comprehensive documentation of all API endpoints, parameters, and output formats for the BV-BRC API (p3api).

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Data Endpoints](#data-endpoints)
- [Query Syntax](#query-syntax)
- [Output Formats](#output-formats)
- [Cross-Collection Downloads](#cross-collection-downloads)
- [Joined Fields (Enrichment)](#joined-fields-enrichment)
- [FASTA Configuration](#fasta-configuration)
- [Genbank Configuration](#genbank-configuration)
- [JSON-RPC Endpoint](#json-rpc-endpoint)
- [Multi-Query Endpoint](#multi-query-endpoint)
- [Bundle/Download Endpoint](#bundledownload-endpoint)
- [Genome Permissions](#genome-permissions)
- [JBrowse Endpoints](#jbrowse-endpoints)
- [Distributed Query Endpoints](#distributed-query-endpoints)
- [Utility Endpoints](#utility-endpoints)
- [Error Handling](#error-handling)

---

## Overview

The BV-BRC API is a RESTful service providing access to bioinformatics data through Solr backends. It supports:

- **RQL (Resource Query Language)** - A URL-safe query syntax
- **Solr Query Syntax** - Direct Solr query parameters
- **Multiple Output Formats** - JSON, CSV, TSV, FASTA, GFF, Genbank, Excel

**Base URL**: Typically `http://localhost:3001` (configurable via `http_port`)

---

## Authentication

Authentication uses Bearer tokens validated against a signing subject URL.

### Header Authentication

```
Authorization: <token>
```

The token is passed directly without a "Bearer" prefix.

### Query Parameter Authentication

For scenarios where headers cannot be set (e.g., form-based downloads):

```
?http_authorization=<token>
```

### Permission Model

For private data collections:
- **Public data**: Documents with `public:true` are visible to all
- **Private data**: Filtered by:
  - `owner:<user_id>` - Owner has full access
  - `user_read:<user_id>` - Read access granted
  - `user_write:<user_id>` - Read/write access granted

Unauthenticated requests only see public data.

---

## Data Endpoints

### Collections

The API provides access to multiple data collections. Common collections include:

| Collection | Description |
|------------|-------------|
| `genome` | Genome metadata |
| `genome_sequence` | Genome sequences (contigs) |
| `genome_feature` | Genomic features (genes, CDS, etc.) |
| `taxonomy` | Taxonomic hierarchy |
| `pathway` | Metabolic pathways |
| `subsystem` | Functional subsystems |
| `protein_structure` | Protein 3D structures |
| `protein_family_ref` | Protein family definitions |
| `sp_gene` | Specialty genes |
| `genome_amr` | Antimicrobial resistance data |
| `epitope` | Epitope data |
| `transcriptomics_experiment` | Gene expression experiments |
| `transcriptomics_sample` | Expression samples |
| `transcriptomics_gene` | Gene expression values |
| `bioset` | Bioset definitions |
| `bioset_result` | Bioset results |

### Query Collection

**`GET /:dataType/`**

Query a data collection.

**URL Parameters:**
| Parameter | Description |
|-----------|-------------|
| `:dataType` | Collection name (e.g., `genome`, `genome_feature`) |

**Query String:**

The query string contains RQL or Solr query operators. See [Query Syntax](#query-syntax).

**Example:**
```bash
# Get all CDS features for a genome
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&eq(feature_type,CDS)&select(patric_id,product)&limit(100)"
```

### Query via POST

**`POST /:dataType/`**

Submit queries via POST body for complex or large queries.

**Content-Type Options:**

| Content-Type | Body Format |
|--------------|-------------|
| `application/rqlquery+x-www-form-urlencoded` | RQL query string |
| `application/solrquery+x-www-form-urlencoded` | Solr query string |
| `application/x-www-form-urlencoded` | `rql=<query>` or `solr=<query>` |

**Example:**
```bash
curl -X POST "http://localhost:3001/genome_feature/" \
  -H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
  -d "eq(genome_id,83332.12)&eq(feature_type,CDS)&limit(100)"
```

### Get by ID

**`GET /:dataType/:id`**

Retrieve a single document by ID.

**Example:**
```bash
curl "http://localhost:3001/genome/83332.12"
```

Multiple IDs can be comma-separated:
```bash
curl "http://localhost:3001/genome/83332.12,83332.13"
```

### Get Schema

**`GET /:dataType/schema`**

Retrieve the Solr schema for a collection.

**Example:**
```bash
curl "http://localhost:3001/genome_feature/schema"
```

---

## Query Syntax

### HTTP Parameters

Query parameters prefixed with `http_` are extracted and used as HTTP headers:

| Parameter | Maps to Header | Description |
|-----------|----------------|-------------|
| `http_accept` | `Accept` | Set output format |
| `http_range` | `Range` | Set pagination range |
| `http_download` | `download` | Enable download mode (higher limits) |
| `http_content-type` | `Content-Type` | Set content type |

**Example:**
```bash
# Request CSV output via query parameter
curl "http://localhost:3001/genome/?limit(10)&http_accept=text/csv"
```

### RQL Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq(field,value)` | Equals | `eq(genome_id,83332.12)` |
| `ne(field,value)` | Not equals | `ne(feature_type,pseudogene)` |
| `lt(field,value)` | Less than | `lt(start,1000)` |
| `le(field,value)` | Less than or equal | `le(start,1000)` |
| `gt(field,value)` | Greater than | `gt(end,5000)` |
| `ge(field,value)` | Greater than or equal | `ge(end,5000)` |
| `in(field,(v1,v2,...))` | In list | `in(genome_id,(83332.12,83332.13))` |
| `terms(field,(v1,v2,...))` | In list, hash-set filter — prefer for large lists | `terms(genome_id,(83332.12,83332.13))` |
| `and(op1,op2,...)` | Boolean AND | `and(eq(genome_id,83332.12),eq(feature_type,CDS))` |
| `or(op1,op2,...)` | Boolean OR | `or(eq(annotation,PATRIC),eq(annotation,RefSeq))` |
| `select(f1,f2,...)` | Field selection | `select(patric_id,product,start,end)` |
| `limit(n)` | Limit results | `limit(100)` |
| `limit(n,offset)` | Limit with offset | `limit(100,200)` |
| `sort(+field)` | Sort ascending | `sort(+start)` |
| `sort(-field)` | Sort descending | `sort(-start)` |
| `keyword(term)` | Full-text search | `keyword(kinase)` |
| `facet((field,name),(mincount,n))` | Faceting | `facet((field,feature_type),(mincount,1))` |

An unrecognized operator returns a clear error naming it, rather than being forwarded to
Solr as a field name (which previously surfaced as `undefined field object:<name>`).

#### `in()` vs `terms()`

Both match a field against a list. They differ in how Solr executes them:

- `in()` builds a boolean OR tree in the main query (`field:(v1 OR v2 OR ...)`).
- `terms()` emits a hash-set filter into `fq` (`{!terms f=field}v1,v2,...`), which Solr
  evaluates in constant time per document and caches in the filter cache.

For a handful of values the difference is negligible. For hundreds or thousands, prefer
`terms()` — the OR tree gets expensive to parse and score.

#### Quoting values

**Percent-encode values, and wrap multi-word values in encoded double quotes:**

```
eq(property,%22Antibiotic%20Resistance%22)      ✅ correct
eq(property,Antibiotic%20Resistance)            ❌ splits into two AND'd terms → 0 results
eq(property,%22Antibiotic+Resistance%22)        ❌ '+' is a literal plus, not a space → 0 results
eq(property,Antibiotic Resistance)              ❌ HTTP 400, raw space rejected
```

Only the first is correct. The middle two return **HTTP 200 with zero results** — no error,
just a silently wrong answer. Use `%20` for spaces, never `+`. Quoting single-token values
is harmless, so "always quote" is the safe rule.

### Solr Query Syntax

Set `Content-Type: application/solrquery+x-www-form-urlencoded` to use direct Solr syntax:

```bash
curl -X POST "http://localhost:3001/genome_feature/" \
  -H "Content-Type: application/solrquery+x-www-form-urlencoded" \
  -d "q=*:*&fq=genome_id:83332.12&fq=feature_type:CDS&rows=100"
```

### Pagination

**Range Header:**
```
Range: items=0-24
```

Response includes:
```
Content-Range: items 0-24/1000
```

**Query Limit:**
```
limit(25)           # First 25 results
limit(25,100)       # 25 results starting at offset 100
```

**Streaming downloads require an explicit `sort()`.**

Downloads (`http_download=true`) paginate internally with Solr's `cursorMark`, which Solr
rejects unless the sort includes the collection's unique key. Without a `sort()` the request
currently returns **HTTP 200 with an empty body** — indistinguishable from "no matches".

```bash
# Returns 200 and ZERO bytes — the query actually failed
curl '.../genome_feature/?eq(genome_id,83332.12)&select(patric_id)&limit(5)\
&http_download=true&http_accept=text/csv'

# Works
curl '.../genome_feature/?eq(genome_id,83332.12)&select(patric_id)&sort(%2Bfeature_id)\
&limit(5)&http_download=true&http_accept=text/csv'
```

Sort on the collection's unique key, or include it as a tie-breaker after your preferred
sort field (`sort(+genome_id,+feature_id)`). Tracked in
`Docs/BUG-stream-failure-returns-empty-200.md`.

### Result Limits

| Mode | Maximum Results |
|------|-----------------|
| Default | 25 |
| Standard query | 25,000 |
| Download mode (`http_download=true`) | 2,500,000 |
| Grouped queries | 99,999,999 |

---

## Output Formats

Set via `Accept` header or `http_accept` query parameter.

| Content-Type | Description | Streaming |
|--------------|-------------|-----------|
| `application/json` | JSON array | ✓ |
| `application/solr+json` | Raw Solr response | ✗ |
| `application/x-ndjson` | Newline-delimited JSON | ✓ |
| `text/csv` | CSV format | ✓ |
| `text/tsv` | TSV format | ✓ |
| `application/vnd.openxmlformats` | Excel XLSX | ✗ |
| `application/dna+fasta` | DNA FASTA | ✓ |
| `application/protein+fasta` | Protein FASTA | ✓ |
| `application/gff` | GFF3 format | ✓ |
| `application/genbank` | Genbank flat file | ✓ (multi-record mode) |
| `application/newick` | Newick tree (taxonomy) | ✗ |
| `application/newick+json` | JSON tree representation | ✗ |
| `application/cufflinks+gff` | Cufflinks GFF format | ✗ |

**Example:**
```bash
# Get protein FASTA
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&eq(feature_type,CDS)&limit(10)" \
  -H "Accept: application/protein+fasta"
```

---

## Cross-Collection Downloads

Download records from one collection using a filter that belongs to **another** collection —
for example, a Specialty Genes grid (`sp_gene`) downloading protein FASTA from
`genome_feature`.

Without this, a client has to resolve the link itself: query the source for matching IDs,
pull them into the browser, then post them back as a giant `in(...)` clause. That is two
round trips and a request body that grows with the result set. This endpoint does the
resolution server-side, in bounded batches, in a single request.

### Request

POST to the **target** collection. The body is the **source** collection's filter, verbatim.

```
POST /{target}/?http_download=true
     &http_accept={format}
     &http_source_collection={source}
     &http_source_link_field={field}
Content-Type: application/rqlquery+x-www-form-urlencoded

<source collection filter>
```

| Parameter | Description |
|-----------|-------------|
| `http_source_collection` | Collection the request body's filter applies to |
| `http_source_link_field` | Field on the source whose values identify target records |

When these are absent the endpoint behaves exactly as before — this is purely additive.

### Example

Protein FASTA for every antibiotic-resistance specialty gene:

```bash
curl -X POST "http://localhost:3001/genome_feature/?http_download=true\
&http_accept=application/protein+fasta\
&http_source_collection=sp_gene&http_source_link_field=feature_id\
&http_fasta_id_fields=patric_id&http_fasta_description_fields=product" \
  -H "Content-Type: application/rqlquery+x-www-form-urlencoded" \
  -H "Authorization: $TOKEN" \
  --data-binary 'eq(property,%22Antibiotic%20Resistance%22)&limit(2500000)'
```

The `sp_gene` filter is resolved to `feature_id` values, those are fetched from
`genome_feature`, and their sequences are joined from `feature_sequence` — all server-side.

### Supported source → target pairs

| `http_source_collection` | `http_source_link_field` | Target | Formats |
|---|---|---|---|
| `sp_gene` | `feature_id` | `genome_feature` | protein/dna FASTA, CSV, TSV, JSON |
| `genome` | `genome_id` | `genome_feature` | protein/dna FASTA, GFF, CSV, TSV, JSON |
| `genome` | `genome_id` | `genome_sequence` | contig DNA FASTA, CSV, TSV, JSON |

Any other combination returns **400** naming the rejected triple. This is an allowlist, not
a filter — a client cannot name arbitrary collections. Extend it via
`crossCollectionDownload.allowedSources` in `p3api.conf`.

### Behavior notes

- **Both sides are permission-scoped independently.** The source query and the target fetch
  each get the requesting user's permission filter. A user sees only records they could
  reach by querying each collection directly.
- **Duplicate link values are collapsed.** Many source rows commonly reference the same
  target record; each target record appears once.
- **One-to-many links are fully expanded.** `genome_id → genome_sequence` returns every
  contig, not one per genome.
- **Memory is bounded** by the batch size (default 2000, `crossCollectionDownload.batchSize`),
  not by the result size.

### Response headers

| Header | Meaning |
|--------|---------|
| `X-Source-Rows` | Source records the filter matched |
| `X-Resolved` | Distinct link values resolved |
| `X-Result-Count` | Target records written |

⚠️ These are computed as the stream finishes, so they **only appear on responses with an
empty body** — a streaming download commits its headers before the counts are known. They
are useful for detecting the empty-result case and for `curl`/log diagnostics, but a client
cannot rely on them for a successful download. A zero-match download returns **200 with an
empty body** and `X-Result-Count: 0`.

---

## Joined Fields (Enrichment)

Some fields can be requested from a collection that does not physically store them; the API
fetches them from the related collection and merges them into the response.

```bash
# genome_name lives in `genome`, not `genome_feature` — it is joined in
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)\
&select(patric_id,genome_name)&limit(5)"
```

Enrichment happens only when a joinable field is explicitly named in `select()` / `fl=`.
It applies to both paginated queries and streaming downloads.

### Default joinable fields

| Collection | Joinable fields (from `genome`) |
|------------|---------------------------------|
| `genome_feature` | `genome_name`, `taxon_id`, `genome_status`, `strain` |
| `sp_gene`, `pathway`, `subsystem`, `genome_amr` | `genome_name`, `taxon_id` |

Configurable per collection via `joinEnrichment` in `p3api.conf`, including multi-hop
chains. See `Docs/JOIN_ENRICHMENT_API.md`.

### Permissions

Joined fetches carry the requesting user's permission filter, so enrichment can never reveal
a record the user could not query directly. If a referenced record is not visible to the
caller, the joined field is simply absent from that row.

### Response headers

| Header | Meaning |
|--------|---------|
| `X-Join-Enrichment` | `true` when enrichment ran, `error` if it failed |
| `X-Join-Fields` | Comma-separated joined field names |
| `X-Join-Time-Ms` | Time spent on join lookups |

Enrichment degrades gracefully: if a join fails the request still succeeds with the joined
fields omitted, and `X-Join-Enrichment: error` is set.

---

## FASTA Configuration

FASTA output headers can be customized via query parameters.

### Default Format

```
>patric_id|refseq_locus_tag|alt_locus_tag| product [genome_name | genome_id]
SEQUENCE...
```

### Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `http_fasta_id_fields` | Comma-separated fields for ID portion | `patric_id,refseq_locus_tag,alt_locus_tag` |
| `http_fasta_id_delimiter` | Delimiter between ID fields | `\|` |
| `http_fasta_id_prefix` | Prefix for ID (e.g., `gi\|`) | (none) |
| `http_fasta_description_fields` | Comma-separated fields for description | `product` |
| `http_fasta_context_fields` | Comma-separated fields for `[context]` | `genome_name,genome_id` |
| `http_fasta_context_delimiter` | Delimiter in context section | ` \| ` |

### Using Genome Metadata Fields

You can include fields from the genome collection using the `genome_metadata.` prefix:

```bash
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&eq(feature_type,CDS)&limit(10)&http_fasta_context_fields=genome_metadata.strain,genome_metadata.assembly_accession" \
  -H "Accept: application/protein+fasta"
```

**Available genome_metadata fields:**
- `genome_metadata.genome_name`
- `genome_metadata.taxon_id`
- `genome_metadata.genome_status`
- `genome_metadata.strain`
- `genome_metadata.assembly_accession`
- `genome_metadata.bioproject_accession`
- `genome_metadata.biosample_accession`

### Examples

**Custom ID fields:**
```bash
# Use only patric_id
?http_fasta_id_fields=patric_id
```

**No context section:**
```bash
# Empty string disables context
?http_fasta_context_fields=
```

**Full customization:**
```bash
?http_fasta_id_fields=patric_id,gene&http_fasta_description_fields=product,function&http_fasta_context_fields=genome_name
```

---

## Genbank Configuration

Genbank format output for genome_feature and genome_sequence collections.

### Request Genbank Format

```bash
curl "http://localhost:3001/genome_sequence/?eq(genome_id,83332.12)&sort(+accession)" \
  -H "Accept: application/genbank"
```

### Configuration Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `http_genbank_merged` | Merge all contigs into single record | `false` |

### Output Modes

**Multi-record mode (default) - Streaming:**

Each contig produces a separate Genbank record. This mode uses streaming:
- Contigs are processed one at a time
- Features for each contig are streamed individually
- Minimal memory usage regardless of genome size

```
LOCUS       NC_000962            4411532 bp    DNA
DEFINITION  Mycobacterium tuberculosis H37Rv chromosome
...
//
LOCUS       NC_000963            5000 bp    DNA
...
//
```

**Merged mode (`http_genbank_merged=true`) - Non-streaming:**

All contigs combined into one record with adjusted coordinates:
- Requires all data in memory for coordinate adjustment
- Features have coordinates adjusted to merged sequence
- `assembly_gap` features mark contig boundaries
- Useful for tools expecting single-record genomes

```bash
curl "http://localhost:3001/genome_sequence/?eq(genome_id,83332.12)&sort(+accession)&http_genbank_merged=true" \
  -H "Accept: application/genbank"
```

### Genbank Record Structure

```
LOCUS       accession           length bp    DNA
DEFINITION  description
ACCESSION   accession
VERSION     accession.version
DBLINK      BioProject: PRJNA...
            BioSample: SAMN...
            BV-BRC: genome_id
KEYWORDS    .
SOURCE      organism name
  ORGANISM  organism name
            lineage...
FEATURES             Location/Qualifiers
     source          1..length
                     /organism="..."
                     /mol_type="genomic DNA"
                     /db_xref="BV-BRC:genome_id"
     CDS             start..end
                     /locus_tag="..."
                     /product="..."
                     /translation="..."
ORIGIN
        1 atgcatgcat gcatgcatgc ...
//
```

---

## JSON-RPC Endpoint

**`POST /`**

Execute JSON-RPC methods.

### Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "methodName",
  "params": [...]
}
```

### Response Format

```json
{
  "id": 1,
  "result": {...}
}
```

### Available Methods

#### `msa` - Multiple Sequence Alignment

Performs MSA using Muscle, Gblocks, and FastTree.

**Parameters:**
```json
["RQL_query_string", "protein|dna"]
```

**Returns:**
```json
{
  "map": { "feature_id": { "genome_name": "...", "patric_id": "..." } },
  "alignment": "FASTA alignment string",
  "tree": "Newick tree string"
}
```

#### `cluster` - Hierarchical Clustering

**Parameters:**
```json
["data_string", { "g": 1, "e": 2, "m": "a" }]
```

Options:
- `g`: Gene clustering method (default: 1)
- `e`: Experiment clustering method (default: 2)
- `m`: Distance metric (default: "a")

#### `proteinFamily` - Protein Family Analysis

**Parameters:**
```json
[
  {
    "familyType": "pgfam|plfam|figfam",
    "genomeIds": ["123.456", "789.012"]
  },
  { "token": "auth_token" }
]
```

#### `transcriptomicsGene` - Transcriptomics Analysis

**Parameters:**
```json
[
  {
    "comparisonIds": ["id1", "id2"],
    "query": "RQL query"
  },
  { "token": "auth_token" }
]
```

#### `biosetResult` - Bioset Result Analysis

**Parameters:**
```json
[
  {
    "comparisonIds": ["bioset_id1", "bioset_id2"],
    "query": "RQL query"
  },
  { "token": "auth_token" }
]
```

#### `panaconda` - Pangenome Graph Building

**Parameters:**
```json
["RQL_query", "alpha", "ksize", "context", "diversity"]
```

---

## Multi-Query Endpoint

**`POST /query`**

Execute multiple queries in a single request.

### Request

**Content-Type:** `application/json`

```json
{
  "queryLabel1": {
    "dataType": "genome",
    "query": "eq(genome_id,123.456)",
    "accept": "application/json"
  },
  "queryLabel2": {
    "dataType": "genome_feature",
    "query": "eq(genome_id,123.456)&eq(feature_type,CDS)"
  }
}
```

### Response

```json
{
  "queryLabel1": { "result": [...] },
  "queryLabel2": { "result": [...] }
}
```

---

## Bundle/Download Endpoint

**`GET/POST /bundle/:dataType/`**

Download bundled files as ZIP or TAR archives.

### Parameters

| Parameter | Description |
|-----------|-------------|
| `types` | Comma-separated file types to include |
| `query` or `q` | Source query |
| `archiveType` | `zip` (default) or `tar` |

### Headers

| Header | Value |
|--------|-------|
| `Accept` | `application/x-zip` or `application/x-tar` |

---

## Genome Permissions

**`POST /permissions/genome/:target_id`**

Update permissions on genome(s) and related collections.

### Authentication

Required. Must be owner of the genome(s).

### URL Parameters

| Parameter | Description |
|-----------|-------------|
| `:target_id` | Comma-separated genome IDs |

### Request Body

```json
[
  { "user": "user1@email.com", "permission": "read" },
  { "user": "user2@email.com", "permission": "write" },
  { "user": "user3@email.com", "permission": "unchanged" }
]
```

### Permission Values

| Value | Description |
|-------|-------------|
| `read` | Read access only |
| `write` | Read and write access |
| `unchanged` | Keep existing permissions |

### Affected Collections

When updating genome permissions, the following collections are also updated:
- `genome_sequence`
- `genome_feature`
- `pathway`
- `sp_gene`
- `subsystem`
- `genome_amr`
- `genome_typing`

---

## JBrowse Endpoints

JBrowse genome browser API integration.

### Track Configuration

**`GET /jbrowse/genome/:id/trackList.json`**

Returns track configuration for a genome.

### Reference Sequences

**`GET /jbrowse/genome/:id/refSeqs.json`**

Returns reference sequence metadata (contigs/chromosomes).

### Features

**`GET /jbrowse/genome/:id/features/:sequence_id`**

Returns features for a sequence region.

**Query Parameters:**
| Parameter | Description |
|-----------|-------------|
| `start` | Start position |
| `end` | End position |

### Name Search

**`GET /jbrowse/genome/:id/names`**

Search for features by name.

---

## Distributed Query Endpoints

### Transparent routing on ordinary requests

Large queries against sharded collections are automatically served by querying the Solr
shards in parallel rather than through a single coordinator. **This is transparent** — the
request and response are identical either way; only latency differs. No client change is
needed, and results have been validated as byte-identical to the standard path against real
user traffic.

A request takes the distributed path when **all** of these hold:

| Condition | Detail |
|-----------|--------|
| Collection is enabled | `genome_feature`, `genome`, `pathway`, `subsystem` by default |
| Method is `query` or `stream` | not `get` |
| Row count ≥ threshold | `minLimitThreshold`, default 10,000 |
| Not a facet or group query | `facet=true` / `group=true` always use the standard path |

**Per-request override** — useful when comparing paths or isolating a suspected difference:

```bash
# Force the distributed path
curl -H "X-Distributed-Query: true" "http://localhost:3001/genome_feature/?..."

# Force the standard path
curl "http://localhost:3001/genome_feature/?...&distributed=false"
```

The header takes precedence over the query parameter. Neither can force facet/group queries
onto the distributed path — that check runs first, since the distributed path cannot compute
`facet_counts`.

**Confirming which path ran.** With `exposeMetadataHeaders` enabled, the response carries
`X-Distributed-Query`. This matters when benchmarking: a query that misses any condition
above silently takes the standard path, which is easy to mistake for "the distributed path
is no faster."

### Test endpoints

Endpoints for exercising distributed parallel queries directly.

**Base path:** `/test/distributed-query`

### Execute Distributed Query

**`POST /test/distributed-query`**

Execute a query distributed across all shards.

**Request Body:**
```json
{
  "collection": "genome_feature",
  "query": "fq=genome_id:123&fq=feature_type:CDS",
  "queryType": "solr",
  "sort": "patric_id asc",
  "fields": "patric_id,product,start,end",
  "limit": 1000,
  "requireSorted": false,
  "clientCount": 4,
  "clientIndex": 0
}
```

**Parameters:**
| Field | Description |
|-------|-------------|
| `collection` | Solr collection name |
| `query` | Query string (RQL or Solr) |
| `queryType` | `rql` or `solr` (default: `rql`) |
| `sort` | Sort specification |
| `fields` | Comma-separated field list |
| `limit` | Maximum results |
| `requireSorted` | Enforce sorted output (default: false) |
| `clientCount` | Partition for parallel clients |
| `clientIndex` | Which partition (0 to clientCount-1) |

**Response:** Newline-delimited JSON (NDJSON)

**Response Headers:**
| Header | Description |
|--------|-------------|
| `X-Query-Id` | Query identifier |
| `X-Stream-Type` | Stream type used |
| `X-Shard-Count` | Number of shards |
| `X-Parallelism` | Parallelism level |
| `X-Total-Found` | Total documents found |

### Other Distributed Query Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/test/distributed-query/config` | GET | Get configuration |
| `/test/distributed-query/stats` | GET | Get statistics |
| `/test/distributed-query/cluster-load` | GET | Get cluster load metrics |
| `/test/distributed-query/shards/:collection` | GET | Get shard info |
| `/test/distributed-query/cancel/:queryId` | POST | Cancel query |
| `/test/distributed-query/cache` | DELETE | Clear caches (admin) |

---

## Data Summary Endpoints

### Summary by Taxon

**`GET /data/summary_by_taxon/:taxon_id`**

Get summary statistics for a taxon.

**Response:**
```json
{
  "unique_family": 123,
  "unique_genus": 45,
  "unique_species": 67,
  "CDS": 1000,
  "mat_peptide": 50,
  "PDB": 10,
  "strains_count": 200
}
```

### Distinct Values

**`GET /data/distinct/:collection/:field`**

Get distinct values for a field.

**Query Parameters:**
| Parameter | Description |
|-----------|-------------|
| `q` | Filter query (default: `*:*`) |

**Allowed Collections/Fields:**

| Collection | Allowed Fields |
|------------|----------------|
| `taxonomy` | `taxon_rank` |
| `epitope` | `epitope_type` |
| `genome` | `host_group`, `host_name`, `geographic_group`, `isolation_country`, `segment`, `subtype`, `season`, `lineage` |
| `genome_feature` | `feature_type` |
| `sp_gene` | `property`, `source`, `evidence` |
| `pathway_ref` | `pathway_name`, `pathway_class` |
| `protein_structure` | `method` |

### Subsystem Summary

**`GET /data/subsystem_summary/:genome_id`**

Get hierarchical subsystem summary for a genome.

---

## Utility Endpoints

### Health Check

**`GET /health`**

Returns server health status.

**Response:** `OK (version)`

### Statistics

**`GET /stats`**

Returns server statistics.

**Response:**
```json
{ "active_requests": 5 }
```

---

## Error Handling

### Error Response Format

```json
{
  "status": 400,
  "message": "Error description"
}
```

### Common Status Codes

| Code | Description |
|------|-------------|
| 400 | Bad request / Invalid query syntax |
| 401 | Authentication required |
| 403 | Forbidden (not owner/authorized) |
| 404 | Resource not found |
| 406 | Not acceptable (invalid content type) |
| 500 | Internal server error |
| 503 | Service unavailable (draining) |

---

## CORS Configuration

The API supports cross-origin requests with the following configuration:

**Allowed Methods:** GET, POST, PUT, DELETE

**Allowed Headers:**
- `if-none-match`
- `range`
- `accept`
- `x-range`
- `content-type`
- `authorization`

**Exposed Headers:**
- `facet_counts`
- `x-facet-count`
- `Content-Range`
- `X-Content-Range`
- `ETag`

**Max Age:** 86400 seconds (24 hours)

---

## Security Headers

All responses include:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Content-Security-Policy: default-src 'self'; script-src 'none'; object-src 'none'
```

---

## Examples

### Basic Query

```bash
# Get 10 genomes
curl "http://localhost:3001/genome/?limit(10)"
```

### Filtered Query with Field Selection

```bash
# Get CDS features for a genome, selecting specific fields
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&eq(feature_type,CDS)&select(patric_id,product,start,end)&limit(100)"
```

### Download Large Dataset

```bash
# Download all features as TSV with increased limit
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&sort(+patric_id)&http_download=true" \
  -H "Accept: text/tsv" \
  -o features.tsv
```

### Protein FASTA with Custom Headers

```bash
# Get protein sequences with custom header format
curl "http://localhost:3001/genome_feature/?eq(genome_id,83332.12)&eq(feature_type,CDS)&http_fasta_id_fields=patric_id&http_fasta_context_fields=genome_metadata.strain,genome_id" \
  -H "Accept: application/protein+fasta"
```

### Genbank Export (Merged)

```bash
# Export genome as single merged Genbank record
curl "http://localhost:3001/genome_sequence/?eq(genome_id,83332.12)&sort(+accession)&http_genbank_merged=true" \
  -H "Accept: application/genbank" \
  -o genome.gb
```

### JSON-RPC Multiple Sequence Alignment

```bash
# Perform MSA on protein sequences
curl -X POST "http://localhost:3001/" \
  -H "Content-Type: application/jsonrpc+json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "msa",
    "params": ["in(feature_id,(feat1,feat2,feat3))", "protein"]
  }'
```

### Authenticated Request

```bash
# Query private data with authentication
curl "http://localhost:3001/genome/?eq(owner,user@example.com)" \
  -H "Authorization: <token>" \
  -H "Accept: application/json"
```
