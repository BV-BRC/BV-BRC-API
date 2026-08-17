# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BV-BRC API (p3api) is a Node.js/Express REST API providing access to BV-BRC bioinformatics data. It acts as a gateway to Solr backends, supporting RQL (Resource Query Language) and Solr query syntax.

## Branch: feature/distributed-query — merge status

**`upstream/alpha` has been merged into this branch** (2026-08-14), so the branch is a clean
fast-forward onto alpha. **PR #189** (`BV-BRC/BV-BRC-API`) is open for the merge back into
alpha. Reports: `Docs/ALPHA_MERGE_REPORT.md` (full), `Docs/ALPHA_PR_BODY.md` (PR text),
`Docs/ALPHA_MERGE_REPORT_SLACK.txt` (paste form).

If the branch diverges from alpha again, **diff against `upstream/alpha`, not the git
merge-base.** The merge-base (`223a99d3`) is stale and predates PRs already merged into alpha
(#176 IDOR, SSRF sanitizer, JBrowse sanitization, numeric validation) — diffing the base
over-counts the delta by showing already-shipped fixes as new. Note those four fixes exist on
*both* lines under different hashes with byte-identical content, which is why the merge was
conflict-free.

Files that alter **preexisting shared-path behavior** (vs. new/leaf code) — where review
effort belongs:

| file | change |
|---|---|
| `middleware/DistributedQuery.js` | join-enrichment hook; pipe-boundary error forwarding |
| `lib/solrjs/rql.js` | `terms()`; empty-group guard; unknown-operator rejection |
| `middleware/APIMethodHandler.js` | join-enrichment hook on `streamQuery` |
| `middleware/DecorateQuery.js` | delegates to `lib/permissionFilter` |

The join-enrichment hooks pipe streaming results through `JoinEnrichmentStream` whenever
`req._joinSpecs` is set. Setup is `try/catch`-guarded; mid-stream errors are handled for the
distributed path (error forwarding across the pipe boundary) but that pattern is newer than
the rest. Everything else is additive, guard-gated, or already in alpha. Against
`upstream/master` the whole distributed-query + join subsystem is net-new. Older breakdown:
`Docs/BRANCH_RISK_ANALYSIS.md`.

## Common Commands

```bash
# Install dependencies
npm install

# Start the server (port 3001 by default)
npm start

# Start with debug output
DEBUG=p3api-server npm start

# Start with distributed query debug output
DEBUG=p3api-server:distributed:* npm start

# Run tests
npm run test-api           # API tests
npm run test-permissions   # Permission tests
npm run test-media         # Media format tests
npm run test-rpc           # RPC tests
npm run test-distributed   # Distributed query tests
npx mocha tests/test-security/  # Security tests (SSRF, path traversal)

# Run a single test file
npx mocha tests/test-api/test.datatype.spec.js

# Build singularity container
npm run build-image
```

## Configuration

- Copy `p3api.conf.sample` to `p3api.conf` and configure Solr endpoints
- Test config: copy `tests/config.sample.json` to `tests/config.json` with test tokens
- Requires Redis for caching (used by apicache)

## Architecture

### Request Flow

1. **app.js** - Express entry point, mounts all routers
2. **routes/dataType.js** - Main data endpoint handler (`/:dataType/`)
3. **Middleware chain** (in order):
   - `http-params` - Extracts `http_*` query params as headers
   - `auth` - Authentication via p3-user module
   - `PublicDataTypes` - Handles public vs private data access
   - `RQLQueryParser` - Converts RQL to Solr query syntax
   - `DecorateQuery` - Adds user permissions to queries
   - `Limiter` - Enforces query limits
   - `JoinFieldInjector` - Injects join key fields into `fl=`, sets `req._joinSpecs`
   - `DistributedQuery` - Routes large queries through distributed shard system
   - `ShardsPreference` - Sets Solr shard routing preferences
   - `checkIfStreaming` - Converts query to stream for downloads
   - `APIMethodHandler` - Executes Solr queries
   - `JoinEnrichment` - Enriches paginated query results with joined fields
   - `media` - Content negotiation and response formatting

### Key Components

- **middleware/** - Request processing middleware
  - `RQLQueryParser.js` - RQL to Solr conversion using solrjs/rql
  - `DecorateQuery.js` - Injects user permission filters
  - `APIMethodHandler.js` - Solr query execution
  - `ExtractCustomFields.js` - Handles custom field extraction

- **media/** - Response serializers by content type
  - JSON, CSV, TSV, Excel, FASTA (DNA/protein), GFF, Newick, GenBank
  - Auto-registered from filenames in `media/index.js`
  - GenBank serializer (`genbank.js`) handles both query and streaming modes — extracts genome_ids from results, then fetches contigs/features per genome via direct Solr queries using the standard `Solrjs` client (not `DirectSolrClient` — see design note below). **GenBank downloads must target the `genome` collection** (see "GenBank downloads" below).
  - FASTA serializers (`dna+fasta.js`, `protein+fasta.js`) use `DirectSolrClient` + `SequenceJoinStream` for efficient sequence lookups with prefetch batching
  - Serializers may declare `contentTypeAliases` (array) in addition to `contentType`; `media/index.js` registers each alias for the same serializer. Used so GFF answers to both `application/gff` and `text/gff3`/`text/x-gff3`.
  - **Design note — GenBank uses Solrjs, not DirectSolrClient**: GenBank's secondary fetches (genome metadata, contigs, features) are small targeted queries scoped to a single `genome_id`. They don't benefit from `DirectSolrClient`'s parallel shard fan-out, and `DirectSolrClient` requires `SolrClusterClient` for replica discovery which needs direct network access to every Solr replica. Using the standard `Solrjs` client (same as `APIMethodHandler`) means GenBank works through any Solr proxy URL — including on offsite laptops without VPN access to the on-prem cluster. FASTA serializers use `DirectSolrClient` because they join large streaming result sets with sequence data, where direct replica access and batched prefetch are worth the complexity.

- **routes/** - Express routers
  - `dataType.js` - Main `/:dataType/` endpoints (query, get, schema)
  - `dataRouter.js` - `/data/` summary endpoints with Redis caching
  - `rpcHandler.js` - JSON-RPC endpoint at `POST /`
  - `genomePermissionRouter.js` - Genome permission management
  - `distributedQueryRouter.js` - Distributed query test endpoints (`/test/distributed-query`)

- **lib/distributed/** - Distributed query system for parallel shard queries and streaming enrichment

- **rpc/** - JSON-RPC method handlers (cluster, msa, proteinFamily, etc.)

### Query Types

- **RQL queries**: `eq(field,value)`, `and()`, `or()`, `select()`, `limit()`, etc.
- **Solr queries**: Direct Solr syntax via `application/solrquery+x-www-form-urlencoded`
- Content-Type header determines query parser selection

### Data Collections

Collections are defined in `p3api.conf`. Common ones: `genome`, `genome_feature`, `taxonomy`, `pathway`, `subsystem`, `protein_structure`

### Private Data Collections

Some collections support private data with owner-based permissions managed via `genomePermissionRouter.js`. These require the `owner`, `user_read`, and `user_write` fields. The genome-related private collections include:
- `genome`, `genome_sequence`, `genome_feature`, `pathway`, `sp_gene`, `subsystem`
- `genome_amr` - Antimicrobial resistance data
- `genome_typing` - Genome typing data (fields: genome_id, scheme_name, id, allele_profile)

## Testing Requirements

- Local Solr instance — **see `Docs/LOCAL_SOLR_SETUP.md`** (Solr 9.6.1, cloud mode, configsets from [bv-brc/bv-brc-solr](https://github.com/bv-brc/bv-brc-solr)). `tests/README.md`'s pointer to `PATRIC3/patric_solr` is stale: that repo is archived and Solr 5.3-era.
- Redis server running
- Test data loaded via `tests/load-test-solr.js` (fetches from `https://www.bv-brc.org/api`, override with `DATA_API_URL`). Note it sets `owner`/`public` but **never `user_read`** — set that field directly in Solr for permission-sharing fixtures.
- Health check: `GET /health` returns "OK (version)"

### Two gotchas that produce silent, misleading failures

**Streaming downloads require an explicit `sort()`.** `solrjs.stream()` paginates with `cursorMark`, which Solr rejects (400, "Cursor functionality requires a sort containing a uniqueKey field tie breaker") unless the query sorts on the collection's uniqueKey. `_streamQuery`'s error path emits `end` (`lib/solrjs/index.js:171-172`), so the client receives **HTTP 200 with zero bytes** rather than an error. Affects any `http_download=true` request without `sort()`, join or no join. Same empty-200-on-failure class as the shard-failure defect found in query-replay testing.

**Token validation can fail silently behind Cloudflare.** `p3-user/validateToken` fetches the signing key from `user.patricbrc.org/public_key`. Cloudflare answers clients whose `User-Agent` it does not recognize with a 403 challenge page; the key fetch then yields HTML, `getSigner` rejects, and *every* token is refused — requests fall through to anonymous and simply return less data, with no error. Symptom: authenticated queries return only public rows.

Diagnose with a **Node** request, not curl — curl's default UA passes, so curl-based checks mislead:

```bash
node -e "require('https').get('https://user.patricbrc.org/public_key', r => console.log(r.statusCode))"   # 403 => blocked
```

The app side is fixed (see "Outbound User-Agent" below). **But `p3-user` is an npm dependency and its fix is a local patch in `node_modules/p3-user/validateToken.js` that does not survive `npm install`.** If authenticated requests suddenly return only public rows, check that patch first — it also adds a guard rejecting non-JSON signer responses, without which the failure surfaces as a generic "invalid token". Upstream PR to `PATRIC3/p3_user` still outstanding.

## Distributed Query System

The distributed query system (`lib/distributed/`) provides direct parallel querying of Solr shards for improved performance on large result sets.

### Key Components

- **DistributedQueryManager** - High-level orchestrator for distributed queries
- **ParallelQueryCoordinator** - Manages concurrent queries across shards (unordered output)
- **MergeSortStream** - K-way merge sort for sorted output across shards
- **ShardCursorStream** - Cursor-based pagination for individual shards
- **SolrClusterClient** - Cluster metadata with caching
- **JoinEnrichmentStream** - Transform stream for inline join enrichment during streaming

### Configuration

Add to `p3api.conf`:
```json
{
  "distributedQuery": {
    "maxParallelism": 8,
    "cursorBatchSize": 2000,
    "excludeNodes": ["hostname1\\.", "hostname2\\."],
    "rejectUnauthorized": false,
    "ca": "/path/to/ca-cert.pem"
  }
}
```

### Debug Output

```bash
# Enable distributed query debugging
DEBUG=p3api-server:distributed:* npm start

# Specific components
DEBUG=p3api-server:distributed:coordinator npm start
DEBUG=p3api-server:distributed:shard-cursor npm start
DEBUG=p3api-server:distributed:cluster npm start
```

### Testing

```bash
# Run distributed query tests
npm run test-distributed

# Test endpoint
curl -X POST http://localhost:3001/test/distributed-query \
  -H "Content-Type: application/json" \
  -d '{"collection": "genome_feature", "query": "fq=genome_id:123"}'
```

### Network Requirements

The distributed query system requires direct network access to all Solr shard replicas. If some hosts are inaccessible, use `excludeNodes` to filter them out. Each shard must have at least one accessible replica.

## Trace Replay & Shakedown Testing

`scripts/replay-queries.js` replays captured real-user API traces against a dev server and deep-diffs each response against the recorded original. It was moved into this module (it originated in the web module) because the queries it exercises are the API's responsibility. It was the primary tool used to shake down the `feature/distributed-query` branch — full findings in `Docs/DISTRIBUTED_QUERY_SHAKEDOWN.md`.

### Trace logs and tokens

- Trace logs: `/disks1/p3/query_log/<user>@...jsonl` (JSONL, one request/response per line; filename embeds the capture timestamp `...YYYY-MM-DDTHH-MM-SS-mmmZ.jsonl`).
- Per-user auth tokens: `token.<user>` in the repo root (git-ignored; treat as secrets).

### Two validation modes

- **Recorded replay** (default) — replay each query against the dev API and diff the live response against the recorded one. Data drift between capture and replay is the dominant noise source.
- **Live A/B** (`--compare <url>`) — send each query to *both* the dev server and a reference endpoint (e.g. production `https://www.bv-brc.org/api`) at the same instant against the same live Solr, and compare the two live responses to each other (recorded response ignored). This isolates *code* differences from time drift; since production has no distributed subsystem, it directly checks that the distributed path matches the standard path. This is the strongest test.

### Key flags

- `--compare <url>` — live A/B against a second endpoint.
- `--inserted-before <ISO|auto>` — appends a `date_inserted` upper bound to each query (`auto` uses the per-entry `ts`, falling back to the timestamp parsed from the log filename) to eliminate post-capture ingestion drift. Applied only to collections that carry `date_inserted` (hardcoded allowlist; override with `--inserted-before-collections`) and only to plain collection queries. RQL colons in the datetime are `%3A`-encoded (`:` is RQL's type-converter separator).
- `--ignore-order` — treat arrays order-insensitively; required for unsorted queries (`in(...)` without `sort(...)`), which Solr returns in a different order over time.
- `--token <tok>`, `--summary`, `--output <file>`.

The comparator ignores volatile `_version_` (Solr's optimistic-concurrency stamp) and the query echo (`responseHeader.params.q`/`.fq`, which differ cosmetically across RQL→Solr formatting). `response.*` is compared first, so ignoring these never hides a real data difference.

### Example

```bash
node scripts/replay-queries.js /disks1/p3/query_log/<user>@...jsonl http://localhost:23001 \
  --token "$(cat token.<user>)" --ignore-order --inserted-before auto --summary
# live A/B against production:
node scripts/replay-queries.js /disks1/p3/query_log/<user>@...jsonl http://localhost:23001 \
  --compare https://www.bv-brc.org/api --token "$(cat token.<user>)" --ignore-order --summary
```

### Shakedown result (for context)

Five defects were found and fixed (alias resolution, dropped `q=` constraint, backpressure EOF truncation, JSON-stream header crash, facet/group misrouting) and the branch was validated as **result-identical to production** across four user workloads — all remaining diffs are SolrCloud replica drift, not code. Note that not every trace exercises the distributed streaming path: a query only engages it when it targets an enabled collection (`genome_feature`, `genome`, `pathway`, `subsystem`), is a plain `query`/`stream` (no `facet=true`/`group=true`), and has `rows >= minLimitThreshold`. Recent traces whose large queries were facet requests or hit non-enabled collections took the standard path and did not test distributed streaming. Check the `X-Distributed-Query` response header (requires `exposeMetadataHeaders`) to confirm whether a query actually engaged the distributed path.

## Security Notes

### SolrQuerySanitizer (`middleware/SolrQuerySanitizer.js`)

Blocks dangerous Solr parameters (`shards`, `stream.url`, `stream.file`, `stream.body`, `qt`, `debug`, `debugquery`, `echoparams`, `collection`, `_route_`, `shards.*`) from reaching Solr. Prevents SSRF, file access, and information disclosure.

Key design decisions:
- **Recursive full decode**: `fullyDecode()` repeatedly applies `decodeURIComponent` (up to 10 iterations) before scanning. Catches double-encoded (`%2526`), triple-encoded (`%252526`), and deeper encoding attacks where `%26` becomes `&` at Solr's decoding layer, creating smuggled parameters.
- **Full-string scan**: The fully-decoded query string is scanned as a whole for dangerous parameter names. If ANY dangerous param is found anywhere in the decoded form, the **entire query is rejected** — no selective stripping.
- **Hard 400 rejection**: Returns `400 { error: "Request contains prohibited query parameters" }` and does NOT call `next()`.
- **Value scanning**: `sanitizeParamsObject()` also checks parameter values (not just keys) for smuggled params via encoded `&`.

Tests: `tests/test-security/security-solr-ssrf.spec.js`

### JBrowse input sanitization (`routes/JBrowse.js`)

All JBrowse endpoints sanitize user inputs before interpolating into Solr queries:
- `sanitizeSolrValue()` strips `& = ? # ; \ { } [ ] " ' \`` from string inputs
- `sanitizeNumeric()` validates against `/^-?\d+(\.\d+)?$/`, returns null on failure → early 400 response

### Other security fixes

- XSS fixes documented in `SECURITY_FIX.md`: parameter name validation in `http-params.js`, error message sanitization in `RQLQueryParser.js`, security headers (CSP, X-Frame-Options, etc.) in `app.js`
- IDOR fix in `APIMethodHandler.js`: multi-ID get requests check permissions on every document, not just the first
- Numeric input validation: invalid numeric params return clean 400 instead of forwarding to Solr (which leaked internal error details)

## Debug Logging

The application uses the `debug` module for logging. Enable debug output by setting the `DEBUG` environment variable.

### Common Debug Patterns

```bash
# All p3api-server debug output
DEBUG=p3api-server:* npm start

# All debug output (very verbose, includes solrjs)
DEBUG=* npm start

# Multiple specific namespaces
DEBUG=p3api-server:app,p3api-server:media,RQLQueryParser npm start
```

### Available Debug Namespaces

#### Core Application
| Namespace | File | Description |
|-----------|------|-------------|
| `p3api-server:app` | app.js | Express app initialization, request handling |
| `p3api-server:web` | web.js | Web server startup |
| `p3api-server:cacheClass` | cache.js | Cache class operations |
| `p3api-server:ExpandingQuery` | ExpandingQuery.js | Query expansion logic |

#### Middleware
| Namespace | File | Description |
|-----------|------|-------------|
| `p3api-server:middleware/APIMethodHandler` | middleware/APIMethodHandler.js | Solr query execution |
| `p3api-server:middleware/DistributedQuery` | middleware/DistributedQuery.js | Distributed query routing decisions |
| `p3api-server:http-params` | middleware/http-params.js | HTTP parameter extraction |
| `p3api-server:cachemiddleware` | middleware/cache.js | Response caching |
| `p3api-server:patchmiddleware` | middleware/patch.js | PATCH request handling |
| `p3api-server:media` | middleware/media.js | Content negotiation, response formatting |
| `RQLQueryParser` | middleware/RQLQueryParser.js | RQL to Solr query conversion |
| `SOLRQueryParser` | middleware/SolrQueryParser.js | Direct Solr query parsing |
| `ShardsPreference` | middleware/ShardsPreference.js | Shard preference selection |
| `p3api-server:SolrQuerySanitizer` | middleware/SolrQuerySanitizer.js | Dangerous Solr param blocking, encoding bypass detection |

#### Routes
| Namespace | File | Description |
|-----------|------|-------------|
| `p3api-server:route/dataType` | routes/dataType.js | Main data endpoint (`/:dataType/`) |
| `p3api-server:route/summary` | routes/dataRouter.js | Summary data endpoints (`/data/`) |
| `p3api-server:route/download` | routes/download.js | File download handling |
| `p3api-server:route/JBrowse` | routes/JBrowse.js | JBrowse genome browser API |
| `p3api-server:route/indexer` | routes/indexer.js | Solr indexing operations |
| `p3api-server:route/multiQuery` | routes/multiQuery.js | Multi-query batch requests |
| `p3api-server:route/rpcHandler` | routes/rpcHandler.js | JSON-RPC endpoint |
| `p3api-server:route/distributed-query` | routes/distributedQueryRouter.js | Distributed query test endpoints |
| `p3api-server:genomePermissions` | routes/genomePermissionRouter.js | Genome permission management |

#### Distributed Query System
| Namespace | File | Description |
|-----------|------|-------------|
| `p3api-server:distributed:manager` | lib/distributed/DistributedQueryManager.js | Query orchestration, stream type selection |
| `p3api-server:distributed:coordinator` | lib/distributed/ParallelQueryCoordinator.js | Parallel shard queries, backpressure handling |
| `p3api-server:distributed:merge-sort` | lib/distributed/MergeSortStream.js | K-way merge sort operations |
| `p3api-server:distributed:shard-cursor` | lib/distributed/ShardCursorStream.js | Cursor pagination per shard |
| `p3api-server:distributed:cluster` | lib/distributed/SolrClusterClient.js | Cluster state, shard/replica discovery |
| `p3api-server:distributed:cache` | lib/distributed/CacheManager.js | Schema/cluster cache hits/misses |
| `p3api-server:distributed:config` | lib/distributed/DistributedQueryConfig.js | Config loading and updates |
| `p3api-server:distributed:join-enrichment-stream` | lib/distributed/JoinEnrichmentStream.js | Streaming join enrichment batching |
| `p3api-server:distributed:utils` | lib/distributed/utils.js | Prewarm queries, URL sanitization |

#### RPC Handlers
| Namespace | File | Description |
|-----------|------|-------------|
| `p3api-server:cluster` | rpc/cluster.js | Cluster analysis RPC |
| `p3api-server:msa` | rpc/msa.js | Multiple sequence alignment |
| `p3api-server:ProteinFamily` | rpc/proteinFamily.js | Protein family analysis |
| `p3api-server:panaconda` | rpc/panaconda.js | Panaconda analysis |
| `p3api-server:BiosetResult` | rpc/biosetResult.js | Bioset result processing |
| `p3api-server:TranscriptomicsGene` | rpc/transcriptomicsGene.js | Transcriptomics gene analysis |

#### External Libraries
| Namespace | File | Description |
|-----------|------|-------------|
| `solrjs` | solrjs | Solr client library |
| `solrjs:rql` | solrjs/rql.js | RQL to Solr conversion in solrjs |

### Debug Examples

```bash
# Debug distributed query with backpressure monitoring
DEBUG=p3api-server:distributed:coordinator,p3api-server:distributed:shard-cursor npm start

# Debug query parsing and execution
DEBUG=RQLQueryParser,p3api-server:middleware/APIMethodHandler npm start

# Debug media serialization (CSV, JSON, etc.)
DEBUG=p3api-server:media npm start

# Debug RPC calls
DEBUG=p3api-server:route/rpcHandler,p3api-server:msa,p3api-server:cluster npm start

# Full distributed query debugging
DEBUG=p3api-server:distributed:*,p3api-server:middleware/DistributedQuery npm start
```

## SolrCloud Maintenance

### Shard Consistency Checker

The `scripts/check-shard-consistency.js` tool diagnoses and fixes SolrCloud replication issues. See `REPLICATION_LAG.md` for detailed documentation.

#### Quick Reference

```bash
# Check consistency for a specific query
node scripts/check-shard-consistency.js -c genome_feature \
  -q "genome_id:123.456" --all-replicas --count-only

# Check ALL leaders for disabled replication
node scripts/check-shard-consistency.js -c genome_feature --check-leaders

# Fix disabled leaders and sync followers
node scripts/check-shard-consistency.js -c genome_feature \
  --check-leaders --fix --force-sync
```

#### Common Issues

1. **Leader replication disabled**: Leaders have `replicationEnabled: false`, preventing followers from syncing
2. **Follower lag**: Followers have fewer documents than leaders
3. **Recovery needed**: Followers need to trigger REQUESTRECOVERY to sync

The tool can automatically detect and fix these issues. See `REPLICATION_LAG.md` for root cause analysis and manual remediation steps.

## Development Notes

### Outbound User-Agent

**Every outbound HTTP request must send a `User-Agent`.** Cloudflare fronts BV-BRC hosts and treats UA-less clients as bots — that is what silently broke token validation (see the Cloudflare note under Testing Requirements). Use the shared helper:

```js
const { userAgent, withUserAgent } = require('../lib/userAgent')

// header literal
headers: { Accept: 'application/json', 'User-Agent': userAgent(), ...opts.headers }

// or merge into an existing headers object (won't clobber a caller-supplied UA)
options = { ...options, headers: withUserAgent(options && options.headers) }
```

- Produces `bvbrc-api/<version>`, e.g. `bvbrc-api/1.9.2-254-gdf4dd12e`.
- **The `bvbrc-<component>/<version>` shape is allowlisted in the BV-BRC Cloudflare rules.** Keep the prefix — an arbitrary UA may be challenged. (Measured: `curl`, `axios`, `wget`, `python-requests` pass; bare `Mozilla/5.0` and a plain `p3-api/1.9.3` are blocked.)
- Version resolves once at load: `BVBRC_API_VERSION` env var → `git describe --tags --always --dirty` → `package.json`. The service runs from a git checkout, so the middle path is the live one; the env var exists for deploys that are not.
- Already wired into `util/http.js` (all exported helpers), `lib/solrjs` (covers all Solr traffic incl. GenBank), `DirectSolrClient`, `SolrClusterClient`, and the axios calls in the FASTA serializers and `util/featureSequence.js`. New clients must opt in themselves — there is no single chokepoint, since the codebase uses four different HTTP libraries.

### SSL/TLS Agent Configuration

When creating new HTTP clients that connect to Solr (or other HTTPS endpoints), you **must** pass the properly configured HTTPS agent with SSL/TLS options. The production Solr cluster uses self-signed certificates.

**Pattern to follow:**

```javascript
const { getConfig } = require('../lib/distributed/DistributedQueryConfig')
const https = require('https')
const fs = require('fs')

const config = getConfig()
const tlsOptions = {}

// Load CA certificate if configured
if (config.ca) {
  if (config.ca.startsWith('/') || config.ca.startsWith('./')) {
    tlsOptions.ca = fs.readFileSync(config.ca)
  } else {
    tlsOptions.ca = config.ca
  }
}

// Allow self-signed certificates if configured
if (config.rejectUnauthorized === false) {
  tlsOptions.rejectUnauthorized = false
}

// Create agent with TLS options
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  ...tlsOptions
})

// Pass agent to clients
const clusterClient = new SolrClusterClient(solrUrl, { agent })
const directClient = new DirectSolrClient(clusterClient, { agent })
```

**Configuration in `p3api.conf`:**
```json
{
  "distributedQuery": {
    "rejectUnauthorized": false,
    "ca": "/path/to/ca-cert.pem"
  }
}
```

**Common error if agent is not configured:**
```
Error: self-signed certificate
```

## Solr Client Library (lib/solrjs)

The `lib/solrjs/` directory contains the inlined Solr client library (formerly the external `solrjs` npm package). It was inlined to simplify maintenance and enable direct modification.

- **`lib/solrjs/rql.js`** — extends the `rql` package's Query prototype with `.toSolr()` to convert RQL AST to Solr query strings. Contains all Solr-specific query handlers (eq, in, terms, genome, facet, etc.) and the cross-collection join logic.
- **`lib/solrjs/index.js`** — Solrjs HTTP client for making requests to Solr (`.query()`, `.stream()`, `.get()`, `.getSchema()`).
- **`rql` npm package** — generic RQL parser (still an external dependency). Parses RQL strings into Query AST nodes.

All `require('solrjs')` calls now use `require('../lib/solrjs')`. Do NOT add solrjs back to package.json.

### RQL `terms()` operator

The `terms(field,(val1,val2,...))` operator generates a Solr `{!terms f=field}val1,val2,...` filter query. This uses Solr's hash-set-based terms filter which is much more efficient than the boolean OR tree generated by `in()` for large value lists (hundreds+ values).

```
# Efficient — uses {!terms} hash filter
terms(genome_id,(123.456,789.012,345.678))

# Less efficient for large lists — uses field:(val1 OR val2 OR val3)
in(genome_id,(123.456,789.012,345.678))
```

Use `terms()` instead of `in()` when the value list is large. The `terms()` output goes into an `&fq=` parameter (cached by Solr's filter cache) rather than into the main `&q=` query.

## Cross-Collection Joins and Query Safety

### How joins are generated

The API generates Solr cross-collection joins in two places — never from client input:

1. `lib/solrjs/rql.js:75-94` — RQL `genome()` clause. When the target collection is `genome`, the filter is inlined directly as `&fq=` (no join needed — genome self-join elimination). For other collections, generates `{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}`.
2. `routes/dataRouter.js:59` — hardcoded summary endpoint for taxon category feature counts.

Both join from the `genome` collection to other collections via `genome_id`. The join filter can include any genome field (taxon_lineage_ids, genome_status, host_name, etc.), not just taxonomy.

### Known crash risk

Broad taxon joins (e.g., `taxon_lineage_ids:2` = all Bacteria) generate 57-93M match DocSets per shard and have caused JVM OOM crashes on data nodes. See `crash-analysis-2026-06-25.md` and `PLAN_SOLR_OVERLOAD_PROTECTION.md` for full analysis and mitigation plan.

### Planned fix: local join resolution

Replace the Solr cross-collection join with API-side resolution using a local SQLite cache (`better-sqlite3`) of `taxon_id → genome_id` mappings, rewriting joins as `{!terms f=genome_id}` filters. See the "Eliminating Cross-Collection Joins" section in `PLAN_SOLR_OVERLOAD_PROTECTION.md`.

## Join Enrichment System

The API supports augmenting query results with fields from related collections. When a client requests fields that belong to a related collection (e.g., `genome_name` from `genome` when querying `genome_feature`), the API fetches and merges those fields automatically.

### Two paths

- **Paginated queries**: `JoinEnrichment` middleware enriches the in-memory docs array after query completion.
- **Streaming downloads**: `JoinEnrichmentStream` (a Transform stream in `lib/distributed/`) buffers documents into batches, enriches via `BatchJoiner`, and pushes enriched docs downstream. Wired into both `DistributedQuery.js` and `APIMethodHandler.js`.

### Request flow

`JoinFieldInjector` runs early in the middleware chain (before query execution). It detects joinable fields in the `fl=`/`select()`, injects join key fields (e.g., `genome_id`), and stores `req._joinSpecs` for downstream use. The downstream middleware checks `req._joinSpecs` to decide whether to pipe through `JoinEnrichmentStream` (streaming) or defer to `JoinEnrichment` (paginated).

### Configuration

Joinable fields are configured per collection in **`lib/joinConfig.js`** (defaults) or `joinEnrichment` in `p3api.conf`. See `Docs/JOIN_ENRICHMENT_API.md` for the full developer reference.

`lib/joinConfig.js` is shared by `JoinFieldInjector` and `JoinEnrichment` — the config loader and spec builder used to be duplicated verbatim in both (the old comment blamed circular dependencies; there is no cycle). Keep it shared: the injector decides which key to put in `fl=` and the enricher walks the hops, so two copies of the grammar drift and the symptom is a silently unenriched field.

**Multi-hop joins.** A joinable field may declare an ordered `path` of hops instead of a single `{from, via, field}`; each hop names a `carry` field feeding the next, and the last names the `field` to attach. `BatchJoiner.enrichDocsChained(docs, spec, ctx)` walks it. Single-hop specs are unchanged. Each hop resolves its **own** permission context from its own target collection — hops span collections with different `publicFree` status, so one shared `fq` is wrong in both directions, and scoping only the first hop rebuilds the permission-blind bug one layer down.

### Permission scoping (fixed 2026-08-06 — was a live cross-user read)

Enrichment's secondary fetches are permission-scoped. **Any new enrichment fetch must carry a permission context** — the fetch bypasses the middleware chain, so `DecorateQuery` does not protect it.

`lib/permissionFilter.js` is the single source of truth:

```js
const { permissionContext } = require('../lib/permissionFilter')
const { permissionFq, scopeKey } = permissionContext({ collection, user: req.user, publicFree: req.publicFree })
```

- `buildPermissionFq()` → the `fq` (`null` for `publicFree` collections, `public:true` anonymous, the `owner`/`user_read` triple otherwise). `DecorateQuery` calls this too, so primary and secondary queries cannot drift apart.
- `permissionScopeKey()` → the cache partition (`public` or `user:<id>`).
- **Both caches are scope-keyed**: `BatchJoiner`'s per-collection LRU (prefix `${scopeKey} ${value}`) and `GenomeMetadataJoinStream`'s own cache. `BatchJoiner` is a process-wide singleton, so an unscoped key serves one user's private row to the next — a fetch-only fix still leaks from a warm cache.
- Callers thread `ctx = { user, publicFree }`: `enrichDocs(docs, spec, ctx)`, and `{ user, publicFree }` in the `JoinEnrichmentStream` / `GenomeMetadataJoinStream` / `SequenceJoinStream` constructors.

**What the bug actually was.** Not latent: `genome` — the target of every configured join — is **not** in `publicFree` (only `feature_sequence` is), so private genome rows were being fetched unfiltered and cached user-blind. Verified against live Solr: with the fix reverted, an *anonymous* request enriching a public feature that references a private genome reads back that genome's name. Requires a public row pointing at a private one, which is exactly what a cross-collection download does. (An earlier draft of the plan claimed all targets were `publicFree` and that users could not enrich their own private data — both wrong; Solr enforces no ACLs here, so an unfiltered fetch returns *more*, never less.)

Tests: `tests/test-permissions/test.permissionfilter.spec.js`, `tests/test-permissions/test.enrichment-permissions.spec.js`. The cross-user cache test is the merge gate — it must fail against a fetch-only fix. Live-Solr procedure: `Docs/LOCAL_SOLR_SETUP.md`; full record in `PLAN_ENRICHMENT_PERMISSIONS.md`.

## Cross-Collection Downloads (implemented 2026-08-07)

Download from one collection using a filter that belongs to another — e.g. a Specialty Genes grid (`sp_gene`) downloading protein FASTA from `genome_feature`. The API resolves the link server-side; the client sends only its grid filter. Plan and full verification record: `PLAN_CROSS_COLLECTION_DOWNLOAD.md`.

```
POST /genome_feature/?http_download=true&http_accept=application/protein+fasta
     &http_source_collection=sp_gene&http_source_link_field=feature_id
body: <the sp_gene grid filter, verbatim>
```

Replaces the web client's two-round-trip prefetch (fetch all IDs into the browser, POST them back as a multi-MB `in(...)` clause).

### Pipeline

`CrossCollectionSource` (after `Limiter`) → `CrossCollectionStream` (after `checkIfStreaming`) → media serializer.

1. **`middleware/CrossCollectionSource.js`** — the security boundary. Validates the (source, linkField, target) triple against a server allowlist (400 on miss), permission-scopes the **source** query with `buildPermissionFq`, and re-parses the source RQL against the *source* collection. Inert when `http_source_*` is absent.
2. **`middleware/CrossCollectionStream.js`** — builds the resolution stream, sets `res.results = { stream }` + `skipAPIMethodHandler` (same contract as `DistributedQuery`), destroys the stream on client disconnect.
3. **`lib/CrossCollectionSourceStream.js`** — cursor-pages the source for link values, fetches target docs via `{!terms}`, prefetches the next page while the current one drains.

Because the stream emits **ordinary target documents** — the same shape `res.results.stream` always has — every serializer works unchanged. `gff` (a cross-collection redirect that is not FASTA) needs no special wiring.

### Non-obvious invariants — break these and downloads fail silently

Every bug found in this feature produced a plausible-looking file with HTTP 200. Assert on **counts**, never on "we got bytes."

- **Emit the leading metadata document.** Solrjs streams do, and serializers skip the first doc (`streamWithBackpressure` `skipFirstDoc` defaults true). A stream without it loses its first record in every serializer.
- **Dedup link values across batches, not just within one.** The source is sorted by its uniqueKey, not the link field, so rows sharing a link value scatter across cursor pages. Per-batch dedup alone emitted 1708 records where 965 were distinct.
- **Pass an explicit `rows` to `fetchByIds` for one-to-many links.** It defaults to `values.length`, assuming one target doc per key — true for md5→sequence, false for `genome_id`→contigs. A 105-contig download returned 2 records.
- **Union serializer join keys into the target `fl`.** The FASTA serializers join to `feature_sequence` on `aa_sequence_md5`/`na_sequence_md5`, which no client `select()` would name. `JoinFieldInjector` protects the ordinary path; this path bypasses it. Missing it yields correct headers with empty sequences (`SERIALIZER_REQUIRED_FIELDS` in `CrossCollectionStream.js`).
- **Read the source RQL from `req._originalRql`**, captured before `RQLQueryParser` rewrites `call_params[0]` against the target. `req._rawBody` only exists for `application/x-www-form-urlencoded`; relying on it dropped the filter for `rqlquery+...` requests, so the download silently resolved the *entire* source collection.
- **Permission-scope every collection independently** — source, target, and each `enrichDocsChained` hop. They differ in `publicFree` status.

### Result counts are not readable from headers

`X-Source-Rows` / `X-Resolved` / `X-Result-Count` are set when resolution finishes, but a streaming download commits headers on the first `res.write`. **They therefore land only on empty downloads.** That is inherent: making them accurate *and* header-visible would require resolving the whole source set before writing a byte, i.e. the unbounded memory this feature avoids. Counts are always in `res.locals.crossSourceStats`, and empty results are logged. The user-visible path is `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` — a **hard dependency**, also because a hidden-form POST cannot read response headers at all.

### Allowlist

`sp_gene.feature_id → genome_feature`, `genome.genome_id → genome_feature`, `genome.genome_id → genome_sequence`. Verified against the website's `DownloadFormats.js` `formatOverrides`. Extend via `crossCollectionDownload.allowedSources` in `p3api.conf`, not code.

### Tests

`tests/test-download/test.cross-collection.spec.js` (HTTP integration; derives expectations from Solr at runtime, skips cleanly without API/collections/tokens), `tests/test-join/test.crosssourcestream.spec.js`, `tests/test-permissions/test.crosscollectionsource.spec.js`, `tests/test-join/test.chainedjoin.spec.js`.

### Future: Solr query cancellation

Solr 9.6.1 supports task cancellation via `canCancel=true&queryUUID=<uuid>` on queries and `GET /solr/admin/tasks/cancel?queryUUID=<uuid>` to cancel. This could be used to cancel in-flight Solr queries when the browser disconnects (`req.on('close')`). See `solr-query-cancellation.md` for design details. **Not yet implemented** — the local join resolution and `timeAllowed` mitigations take priority. Cancellation is a general resource hygiene improvement for later.

## GenBank Downloads

GenBank export is served by `media/genbank.js`. Full investigation, diagnosis, and performance history: `Docs/GENBANK_DOWNLOAD_PERFORMANCE.md`.

### Must target the `genome` collection

Request GenBank from `/genome/`, not a feature-level collection:

```
GET /genome/?in(genome_id,(ID1,ID2,...))&http_download=true&http_accept=application/genbank
```

The serializer only needs the genome_id list from the query and fetches contigs/features per genome itself. Requesting from `genome_feature` would stream millions of feature docs just to recover the genome_id list. A guard in `routes/dataType.js` **rejects GenBank downloads on any non-`genome` collection with a 400** pointing at `/genome/`. Update client download links accordingly.

### Streaming design

- One record per contig (default) or a single merged record (`http_genbank_merged=true`).
- Per-genome data is fetched in one parallel wave (`fetchGenomeData`: genome + contigs + features), and the next genome is prefetched while the current one is written (pipeline).
- Writes honor `res.write` backpressure (`writeChunk` awaits `drain`) so memory stays bounded on slow clients; the loop stops on client disconnect (`res.destroyed`/`close`).
- Sets `X-Accel-Buffering: no` so nginx doesn't re-buffer and defeat backpressure.

### Solr fetch resilience (env-tunable)

The per-genome Solr fetches have a request timeout + retry as a backstop against stale keepalive sockets (see the perf doc — the production stalls were traced to HAProxy `maxconn` shedding keepalive connections):

- `GENBANK_SOLR_TIMEOUT_MS` (default 30000) — aborts a hung Solr request via `req.destroy`. Consider lowering to ~5000; a healthy fetch is ~400ms.
- `GENBANK_SOLR_RETRIES` (default 1) — retry on a fresh connection after timeout.
- `GENBANK_SOLR_KEEPALIVE=0` — give the fetches a non-keepAlive agent (diagnostic A/B).

`Solrjs.query()` honors an optional `this.timeout` / `options.timeout` (added for this).

### Diagnostics

- `DEBUG=p3api-server:media:genbank:timing` — per-genome `fetchWait`/`format`/`write` ms plus a `REQUEST SUMMARY`. This is what localized the stall to Solr fetch wait.
- `scripts/repro-genbank-stall.sh <base_url> [rate] [rql]` — curl+pv reproducer with per-interval rate log and a completeness check. **Test unthrottled** to see real stream behavior; `--rate` throttling makes curl the bottleneck and masks upstream stalls (use it only to simulate a slow client for backpressure tests).

### Related infrastructure note

The API reaches Solr through a pair of HAProxy load balancers (`p3.theseed.org:7001`), not directly. Keep HAProxy — it provides Solr coordinator health-checking and failover. A too-low HAProxy `global maxconn` was the root cause of the download stalls (it shed the API's keepalive sockets, which the API then hung on for ~166s with no timeout). See the perf doc for the full write-up.
