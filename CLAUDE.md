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

## Dependency Security Maintenance

Baseline refresh done 2026-08-17 (branch `deps/security-refresh`). `npm audit` went
**106 → 53** advisories (critical 15→11, high 59→22). Test results are byte-identical to
pristine alpha, so the refresh introduced no regressions.

### Never declare `npm` as a dependency

`package.json` used to list `"npm"` and `"install"` — neither imported anywhere
(`require('npm')` / `require('install')` → 0 hits), nothing invoking
`node_modules/.bin/npm`. They arrived incidentally in `84e20f6f`, a commit about solrjs that
never mentions them; almost certainly a stray `npm install npm install`.

Declaring `npm` vendors the **entire npm CLI** into the tree: 143 of 1339 lockfile entries
lived under `node_modules/npm/`. Its subpackages (`@npmcli/*`, `@sigstore/*`, `libnpm*`,
`pacote`, `cacache`) declare `node: ^20.17.0 || >=22.9.0`, so on prod's Node 22.4.1 every
install printed **80+ `EBADENGINE` warnings** — npm complaining that a vendored copy of
*itself*, which nothing would ever execute, didn't match the running Node. Production runs
from a persistent checkout on the **system** npm, so the vendored copy was pure dead weight.

Removing both dropped 145 packages. `apicache` was bumped `^1.6.2 → ^1.6.3` at the same time
(1.6.2 declares `node: >=8 <=15`, the one remaining warning; 1.6.3 relaxes it to `>=8`).
`npm install` is now silent on EBADENGINE.

If EBADENGINE noise reappears, check for a package that vendors a toolchain before assuming
the running Node is wrong. Note the repo pins **no** Node version (no `engines`, no
`.nvmrc`), so nothing catches this class of drift automatically.

### What changed

Only three manifest entries moved; everything else was a lockfile-only in-range update
(`npm audit fix --package-lock-only`, which needed no `package.json` edits and cleared 49
advisories on its own).

| dep | from | to | why it was safe |
|---|---|---|---|
| `ejs` | `^2.7.4` | `^3.1.10` | major, but the 2→3 break is the removal of old-style `<% include x %>`. **The 5 templates in `views/` contain zero includes** and all compile clean under 3.1.10. |
| `nodemailer` | `^6.10.1` | `^9.0.5` | major, but `lib/mailer.js` uses only `createTransport` (sendmail + SMTP + auth + tls) and callback-style `sendMail`. All verified working on 9.0.5. |
| `nconf` | `^0.10.0` | `^0.13.0` | major, but `config.js:234` is the sole consumer — one chained `argv().env().file().defaults()`. Verified identical resolution on 0.13. |

### Do not bump these without a real migration

`npm audit fix --force` will offer them. Each is a genuine breaking change, not a version bump:

- **`redis` 2.x → 4+** — v4 removed the callback API. `rpc/proteinFamily.js` and
  `routes/dataRouter.js` both use `client.get(key, cb)` / `client.set(k, v, 'EX', ttl)`.
  Needs a promise/`node-redis` v4 rewrite plus an `apicache` compatibility check.
- **`pm2`** — process supervisor, not imported by any app code. Its CVEs are ops-surface, not
  request-path. It is a **devDependency**; the container installs pm2 globally
  (`singularity.def:51`) and prod runs `app.js` under pm2 via `default_pm2_config.js`.
  (`forever` used to sit here too — **removed 2026-08-17**, see below.)
- **`request-promise` / `request`** — deprecated upstream, no fix exists. Now the source of
  **both** remaining criticals. Tracked as future work with a full scope breakdown below
  ("Future work: retire `request-promise`") — not to be bundled into a dependency refresh.
- **`mocha` 7 → 11** — dev-only; would need a test-suite pass.

### Deprecation warnings on `npm install`

Distinct from vulnerabilities — `npm audit` never reports these, so they need their own pass.
After the refresh, the ones that remain on a cold install are **almost all transitive and not
fixable from this repo**:

| warning | comes from | ours? |
|---|---|---|
| ~~`nodemailer@1.11.0`, `mailcomposer@2.1.0`, `buildmail@2.0.0`~~ | ~~`p3-user`'s pinned nodemailer 1.x~~ | **cleared** by the p3-user repin |
| ~~`bson@0.2.22`~~ | ~~`p3-user` → `^0.2.17`~~ | **cleared** — p3-user dropped mongodb/bson |
| `request-promise@4.2.2` | **root** (`routes/genomePermissionRouter.js` + tests) | yes, but needs porting to `axios` |
| `rimraf@3.0.2` | `@mapbox/node-pre-gyp`, `flat-cache`, `temp`, `utile` | no |
| `@humanwhocodes/*` | `eslint@7` | no — see below |
| `eslint@7.32.0` | direct devDep | blocked, see below |

`uuid` was the one clean win: root dep at `^2.0.1`, used only as `Uuid.v4()` in
`routes/indexer.js:204`. Bumped to `^11.1.1` — that named export is unchanged, and although
uuid 11 is `"type": "module"`, its `exports` map has a `node.require` condition so plain CJS
`require('uuid')` still resolves. Verified.

**`eslint` cannot be bumped in isolation.** 7 → 8 fails `ERESOLVE`
(`eslint-config-standard@12` and `eslint-plugin-import@2.22` pin peer
`eslint@"^2 || … || ^7.2.0"`). See "Future work: eslint stack migration" below — dependabot
tried this in #196 and produced a PR that does not install.

### Future work: mocha 11 (clears the `js-yaml` advisories)

The four open `js-yaml` alerts (all **development** scope) come from **mocha**, not eslint.
`mocha@^7.2.0 → ^11.8.0` alone takes `mocha/node_modules/js-yaml` from 3.13.1 to 4.3.1 and
drops one high advisory (high 14 → 13). Tested: offline suites still pass at the same
247/2 counts.

**Caveat that will bite:** mocha 11 no longer accepts a bare directory argument.
`mocha tests/test-util/` returns *"No test files found"* rather than erroring usefully, so any
invocation passing a directory needs an explicit glob (`tests/test-util/*.spec.js`) or
`--recursive`. The `package.json` scripts already use `test.*.spec.js` patterns and are fine;
ad-hoc commands and CI invocations are what to check.

The top-level `js-yaml@3.15.1` is pulled by **eslint 7** itself, so it only clears with the
migration below.

### Future work: eslint stack migration

Not a version bump — a migration, and dependabot's #196 is the cautionary example. It bumped
`eslint` to `^10.8.1` while leaving `eslint-config-standard@12` and `eslint-plugin-node@7`
behind, producing a PR where **`npm install` and `npm ci` both fail** on
`eslint-plugin-import@2.32.0`'s `eslint <= 9` peer. Forced through with `--legacy-peer-deps`
it installs but still can't run: eslint 9+ requires flat config and this repo has
`.eslintrc.json`.

A coherent target exists — `eslint-config-standard@17` peers `eslint ^8.0.1`,
`eslint-plugin-import ^2.25.2`, `eslint-plugin-promise ^6.0.0`, and **`eslint-plugin-n`**,
which is a *different package* from the currently-declared `eslint-plugin-node`. So the work
is: swap that plugin, move all five eslint packages together, convert `.eslintrc.json` (and
`.eslintignore`, also removed in eslint 9) to `eslint.config.js`, then re-run lint against the
56 pre-existing errors and decide which are now real.

### Where the remaining 53 live

Almost none are in first-party request-path code:

- ~~**`p3-user` tree (6 criticals)**~~ — **resolved 2026-08-17.** See below.
- **`pm2` tree** — ops tooling, see above.
- **`npm` bundled (3)** — vendored inside the `npm` dependency's own `node_modules`.
- **`axios`** — the *direct* dep is already at latest (1.19.0) and clean; the remaining
  alert is `@pm2/js-api`'s pinned 0.21.4.

### p3-user moved repos (2026-08-17)

The dependency pin now points at **`BV-BRC/BV-BRC-UserManagement`**, not the old
`PATRIC3/p3_user`. That repo received its own dependency refresh (`p3-user` 2.0.1), which
cleared the largest remaining cluster here: `npm audit` **53 → 47**, criticals **11 → 6**.

Gone from the tree entirely: `bson@0.2.22`, `mailcomposer@2.1.0`, `buildmail@2.0.0`, and the
nested `nodemailer@1.11.0` / `ejs@2.5.9` / `nconf@0.6.9` copies. p3-user dropped its
`mongodb` dependency, which is what took `bson` with it. Total package count 1191 → 1106.

**The local `validateToken.js` patch is obsolete — do not re-apply it.** The old note here
said the Cloudflare User-Agent fix lived in `node_modules/p3-user/validateToken.js` and had to
be re-applied after every `npm install`. Both halves of that patch are now upstream:
`validateToken.js` sends `withUserAgent()` and carries the non-JSON guard that turns a
challenge-page response into a clear error instead of a generic "invalid token". Verified
against live Cloudflare — p3-user sends `bvbrc-user/2.0.1` and
`https://user.patricbrc.org/public_key` answers **200** with real JSON.

**The `SigningSubject` bug was worse than it looked — fixed upstream, pin bumped to
`105a60b7`.** An earlier draft of this note called it a harmless `ReferenceError` on an
unreachable path. That was wrong on both counts, and the correction is worth keeping:

```js
if (parsedToken.SigningSubject !== signingSubject) {
  new Error('Invalid Signing Subject: ' + signingSubjectURL)   // never thrown; wrong variable
}
```

- It *was* reachable. A mismatched subject produced
  `500 {"message":"signingSubjectURL is not defined"}` — reproducible against production.
  The service was fail-closed **only by accident**: the `ReferenceError` aborted the request.
- **Fixing only the variable name would have opened an authentication bypass.** With the
  `ReferenceError` gone and nothing thrown, execution falls through to
  `getSigner(parsedToken.SigningSubject)` — fetching the verification key from a URL *the token
  itself supplies*. An attacker publishes a keypair, signs a token claiming any identity
  (including admin), points `SigningSubject` at their own server, and this service fetches that
  key and verifies against it. Confirmed end to end against the pre-fix logic.

The fixed branch resolves `false` and logs, so a mismatched subject is refused **before any
fetch**. Verified here after the repin: a token with `SigningSubject=https://evil.example.com/key`
is rejected with no outbound request.

The same upstream commit replaced `request` with node's native `http`/`https` in `getSigner`,
adding a non-http(s) protocol rejection, a 64 KiB response cap, a 15s timeout, and distinct
handling for non-200 vs non-JSON. It also fixed token parsing to split on the *first* `=`, so a
`SigningSubject` carrying a query string is no longer truncated.

**Moral for this codebase:** a dead-code guard is not automatically low-severity. Check what
happens if it starts working.

### `forever` removed (2026-08-17)

**The services run under pm2, not forever.** `forever` was a declared *runtime* dependency
that nothing used: `require('forever')` → 0 hits, and it appears nowhere in the deploy path
(`singularity.def` installs pm2 globally and runs `pm2-runtime`; `default_pm2_config.js` points
at `./app.js`). BV-BRC-UserManagement dropped it at the same time.

Removing it took **206 packages** out of the tree and cleared the whole
`forever → forever-monitor → broadway → flatiron → utile → optimist` chain, along with the
`minimist@0.0.10`, `chokidar@2`, `micromatch@3`, `braces@2` copies those pulled in.

Order matters: dropping `forever` from `package.json` alone changes **nothing**, because the
old `p3-user` pin depended on it too. It only takes effect stacked on the p3-user repin — the
new `p3-user` has no `forever` dependency. If you try this against an old checkout and see the
audit numbers not move, that's why.

### Future work: retire `request-promise` (the last 2 criticals)

**Deferred deliberately — not an oversight.** After the p3-user repin and the `forever`
removal, `npm audit` sits at **35 advisories, 2 critical**, and *both* criticals
(`form-data`, `request`) come from the single `request-promise` dependency. It is deprecated
upstream with **no fix available**, so the only remedy is retiring it.

As of pin `105a60b7`, **`request-promise` is the only reason `request` is still in the tree
from our side** — p3-user dropped its own `request` dependency in favour of native
`http`/`https`. The remaining declarer is `dactic@0.8.12`, which lists `request` but never
actually calls it (a phantom dependency, and 0.8.12 is the newest release), so retiring
`request-promise` here is what removes the last real use.

Scope is small and well-bounded — 5 files, one of them production:

| file | |
|---|---|
| `routes/genomePermissionRouter.js:32,208` | **the only production use** — one `request(url, {...})` POST to Solr in `updateSOLR()` |
| `tests/generate-local-data-files.js:22` | test tooling |
| `tests/index-local-data-files.js:21` | test tooling |
| `tests/test-permissions/update-genome-perms.js:3` | test tooling |
| `tests/test-permissions/test.spec.js:17` | test tooling |

`axios` is already a direct dependency at 1.19.0 and is the natural replacement. The
production call passes `json: true`, an explicit `content-type`/`accept`, a custom `agent`
(`solrAgent`), and `body:` — under axios that becomes `data:`, `httpAgent`/`httpsAgent`, and
automatic JSON handling. **Note the response-shape change**: `request-promise` resolves to the
parsed body, axios resolves to a response object (`res.data`). The call site currently ignores
the body on success, so that difference is invisible there — but it will matter in the test
files, which do consume responses.

Also worth handling in the same pass: `request-promise` sends no `User-Agent`, so per the
"Outbound User-Agent" section the replacement must use `withUserAgent()`.

### Re-running this analysis

```bash
npm audit --json > /tmp/audit.json
# group remaining high/critical by the root package that would fix them:
node -e "const a=require('/tmp/audit.json');Object.values(a.vulnerabilities).filter(v=>['critical','high'].includes(v.severity)).forEach(v=>{const f=v.fixAvailable;console.log((v.isDirect?'DIRECT ':'       ')+v.name.padEnd(22),v.severity.padEnd(9),f===true?'in-range':f&&f.name?f.name+'@'+f.version+(f.isSemVerMajor?' MAJOR':''):'NONE')})"
```

`isDirect` is the field that matters — a transitive alert usually means bumping some *other*
package, and `fixAvailable.isSemVerMajor` marks the ones that need the review above.

**The 9 open dependabot PRs (#117, #118, #123, #124, #125, #126, #128, #129, #133) are all
obsolete.** They date from 2022–2023, all target `master`, all conflict, and every package
they name is either already patched here or superseded by this refresh. Close them rather
than merging.

### Baseline test expectations

Two failures are **pre-existing on pristine alpha** — do not treat them as regressions:

- `tests/test-util/test.fastaHeaderFormatter.spec.js` — "should handle missing values
  gracefully" (expects `>feat1 Test`, gets `>feat1| Test`)
- `tests/test-distributed/test.config.spec.js` — "should return current configuration"
  (config key drift: `genomeMetadata*` / `sequenceJoin*` keys)

Offline suites (`test-util`, `test-join`, `test-distributed`) run without Solr or Redis:
**247 passing / 2 failing**. `test-security` and `test-api` need a live API and will
`ECONNREFUSED` without one. `npx eslint` reports 56 pre-existing errors on the files touched
here; that count is unchanged by the refresh.

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
