# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BV-BRC API (p3api) is a Node.js/Express REST API providing access to BV-BRC bioinformatics data. It acts as a gateway to Solr backends, supporting RQL (Resource Query Language) and Solr query syntax.

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
   - `APIMethodHandler` - Executes Solr queries
   - `media` - Content negotiation and response formatting

### Key Components

- **middleware/** - Request processing middleware
  - `RQLQueryParser.js` - RQL to Solr conversion using solrjs/rql
  - `DecorateQuery.js` - Injects user permission filters
  - `APIMethodHandler.js` - Solr query execution
  - `ExtractCustomFields.js` - Handles custom field extraction

- **media/** - Response serializers by content type
  - JSON, CSV, TSV, Excel, FASTA (DNA/protein), GFF, Newick
  - Auto-registered from filenames in `media/index.js`

- **routes/** - Express routers
  - `dataType.js` - Main `/:dataType/` endpoints (query, get, schema)
  - `dataRouter.js` - `/data/` summary endpoints with Redis caching
  - `rpcHandler.js` - JSON-RPC endpoint at `POST /`
  - `genomePermissionRouter.js` - Genome permission management
  - `distributedQueryRouter.js` - Distributed query test endpoints (`/test/distributed-query`)

- **lib/distributed/** - Distributed query system for parallel shard queries

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

- Local Solr instance with patric_solr schema
- Redis server running
- Test data loaded via `tests/load-test-solr.js`
- Health check: `GET /health` returns "OK (version)"

## Distributed Query System

The distributed query system (`lib/distributed/`) provides direct parallel querying of Solr shards for improved performance on large result sets.

### Key Components

- **DistributedQueryManager** - High-level orchestrator for distributed queries
- **ParallelQueryCoordinator** - Manages concurrent queries across shards (unordered output)
- **MergeSortStream** - K-way merge sort for sorted output across shards
- **ShardCursorStream** - Cursor-based pagination for individual shards
- **SolrClusterClient** - Cluster metadata with caching

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

## Security Notes

Recent XSS fixes documented in `SECURITY_FIX.md`:
- Parameter name validation in `http-params.js`
- Error message sanitization in `RQLQueryParser.js`
- Security headers (CSP, X-Frame-Options, etc.) in `app.js`

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

- **`lib/solrjs/rql.js`** — extends the `rql` package's Query prototype with `.toSolr()` to convert RQL AST to Solr query strings. Contains all Solr-specific query handlers (eq, in, genome, facet, etc.) and the cross-collection join logic.
- **`lib/solrjs/index.js`** — Solrjs HTTP client for making requests to Solr (`.query()`, `.stream()`, `.get()`, `.getSchema()`).
- **`rql` npm package** — generic RQL parser (still an external dependency). Parses RQL strings into Query AST nodes.

All `require('solrjs')` calls now use `require('../lib/solrjs')`. Do NOT add solrjs back to package.json.

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

### Future: Solr query cancellation

Solr 9.6.1 supports task cancellation via `canCancel=true&queryUUID=<uuid>` on queries and `GET /solr/admin/tasks/cancel?queryUUID=<uuid>` to cancel. This could be used to cancel in-flight Solr queries when the browser disconnects (`req.on('close')`). See `solr-query-cancellation.md` for design details. **Not yet implemented** — the local join resolution and `timeAllowed` mitigations take priority. Cancellation is a general resource hygiene improvement for later.
