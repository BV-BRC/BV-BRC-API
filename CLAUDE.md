# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BV-BRC API (p3api) is a Node.js/Express REST API providing access to BV-BRC bioinformatics data. It acts as a gateway to Solr backends, supporting RQL (Resource Query Language) and Solr query syntax.

## Branch state (2026-09-03)

**`origin/alpha` is 25 commits AHEAD of `origin/master`, 0 behind.** Master can be
fast-forwarded; there is nothing to merge the other way. **This is the reverse of the note
that stood here through 2026-08-25**, which said master was 14 ahead with nothing to merge
back — that was true then and is not now. This section goes stale fast; check with
`git rev-list --left-right --count origin/master...origin/alpha` rather than trusting any
sentence in it.

- `origin/master` = **`6397c6cf`**, `origin/alpha` = **`5008579c`**.
- **PR #202** (`bf9c9207`) merged alpha → master, bringing the distributed-query,
  join-enrichment, and cross-collection-download subsystems (originally #189, `be1b75aa`)
  onto master. **PR #203** (`6397c6cf`) added a Solr request timeout on the main data path.
  Those two are what made master briefly the ahead branch.
- **PR #206** (`4f64b1d4`, merged 2026-09-03) put 21 commits on alpha: the whole self-call
  elimination, the `ShardCursorStream` POST fix, and the `MinHeap` UTF-8 comparator fix.
- **PR #207** (`5008579c`, merged 2026-09-03) added the `terms()` `cache=false` emission and
  the matching `Limiter` detection.

**Master does not have the two worker-crash fixes.** `31a1d5ad` (`dataRouter`) and
`6b1335e4` (`ExpandingQuery`) are on alpha only — `git branch -r --contains 31a1d5ad` lists
`origin/alpha` and nothing else. Both close paths where an ordinary unauthenticated client
mistake aborts a worker (see "`JSON.parse` on a self-call body is how a worker dies" below).
Whether that warrants a merge to master ahead of the normal cadence is a maintainer call, but
it should be a deliberate one.

Open PRs as of 2026-09-03: **#205** (master ← dependabot, fast-uri 3.1.5→3.1.7) and **#151**
(alpha ← `bugfix/private-structure`, `protein_structure` access control, open since
2026-03-05). Note the 9 dependabot PRs listed as open under "Dependency Security
Maintenance" below (#117, #118, #123–#126, #128, #129, #133) are **closed** — that paragraph
is stale in the other direction.

Merge-resolution notes worth keeping: the only conflicts were `package.json` and
`package-lock.json`, and `package.json` was resolved **in alpha's favour on all four
differing lines** — keep the inlined `lib/solrjs`, keep `dojo-declare`, keep the two test
scripts, and **do not restore the external `solrjs` dependency**. Taking master's side there
looks right (its dependency work is newer) but reintroduces the package while the code
imports `lib/solrjs`; both resolve, so it fails silently. Full risk analysis:
`Docs/ALPHA_TO_MASTER_MERGE_RISK.md`.

Historical reports (`Docs/ALPHA_MERGE_REPORT.md`, `Docs/ALPHA_PR_BODY.md`,
`Docs/ALPHA_MERGE_REPORT_SLACK.txt`, `Docs/BRANCH_RISK_ANALYSIS.md`) describe the pre-#189
delta and are provenance only.

**Rolling the deployment between these two points requires `npm ci`, not just a checkout.**
The manifests differ: pre-merge master needs the external `solrjs` package, post-merge
master needs `dojo-declare` for the inlined client. A bare `git checkout` in either
direction gives every worker `Cannot find module …`. Verify before restarting:

```bash
node -e "require('dojo-declare/declare'); require('./lib/solrjs'); console.log('deps OK')"
```

**Offline-suite baseline on `origin/alpha` is 370 passing / 1 failing** (measured 2026-09-03,
`npx mocha tests/test-util/ tests/test-join/ tests/test-distributed/`) — the known
`fastaHeaderFormatter` case. It was 351/1 before PR #207 added 19 offline specs. Earlier
notes here said 350/1 and then 327/1; both were stale. The self-call work's own specs all
need a live API and a populated Solr, so none of them land in these three suites — run those
against `:23001` with the command in `PLAN_ELIMINATE_SELF_CALL.md`.

**`distributedQuery` defaults to `enabled: true` with an empty `excludeNodes`,** and the path
needs direct network access to every Solr replica, which the production deployment does not
have. Production `p3api.conf` sets `enabled: false` — that is deliberate, keep it. The
`excludeNodes` list lives only in that untracked file.

## Planning docs (not yet implemented)

Repo-root `PLAN_*.md` files are proposals, in varying states of vetting:

| doc | subject |
|---|---|
| `PLAN_ELIMINATE_SELF_CALL.md` | **DONE — merged to alpha as PR #206** (`4f64b1d4`, 2026-09-03). All 8 steps. Not on master; see below for what remains deferred. |
| `PLAN_PRIVATE_METADATA_OVERLAY.md` | Private per-user metadata collection overlaying `genome` — display, filter, facet. See below. |
| `PLAN_GENOME_POSTFILTER.md` | JS-side post-filtering for negation-only `genome()` conditions |
| `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` | SSE start/complete events for downloads (hidden-form POSTs can't read headers) |
| `PLAN_SOLR_OVERLOAD_PROTECTION.md` | Multi-layer throttling; broad-taxon join OOM mitigation |

### HTTP self-calls (merged to alpha as PR #206; not on master)

**The API called its own listening port instead of invoking handlers in-process**, at 17
sites. Over a 36-hour production window `::ffff:127.0.0.1` was the top client by a factor of
three: **33,101 requests (33% of all traffic), 615,681s cumulative**. Beyond the wasted round
trip it is a resource-loop hazard — an outer request holds a slot in the same worker pool its
children need, so parents can occupy every slot while children queue behind them.

Find the survivors with `grep -rn "get('http_port')" --include=*.js` (excluding `app.js`'s own
`listen`). The sites were **identical on master and alpha**; the fixes below are now on
**alpha only**, so every one of them is still live on master.

**There is no remote named `upstream`.** Earlier notes here and in the plan said "pushed to
upstream"; that was wrong. The remotes are `origin`
(`https://github.com/BV-BRC/BV-BRC-API`, canonical) and `bob`
(`https://github.com/olsonanl/p3_api`, a personal fork). `bob` was an SSH URL until
2026-09-03 and no key is loaded on this host, so pushes failed with
`Permission denied (publickey)`; it is HTTPS now. Also note **`gh pr edit` does not work
against this repo** — it fails with `GraphQL: Projects (classic) is being deprecated
(repository.pullRequest.projectCards)`. `gh pr create` is fine; to change a body afterwards
use `gh api -X PATCH repos/BV-BRC/BV-BRC-API/pulls/<n> -F body=@file`.

Shipped, based on `6397c6cf` (master) and merged into alpha by `4f64b1d4`:

- **`febb9cf8`** — `multiQuery` no longer stores sub-query failures as results.
  `util/http.js`'s `httpRequest` discards `res.statusCode` and resolves the body regardless,
  so a 500's error body was `JSON.parse`d into the caller's result slot inside an outer HTTP
  200. New `httpRequestWithStatus()` exposes the status; `httpRequest` is unchanged because
  four other call sites expect a bare string.
- **`fcee5a0a`** — `lib/internalQuery.js`, inert until the conversions land. Goes **direct to
  Solr** rather than synthesizing a `req`/`res` and replaying the ~27-middleware chain,
  following the `media/genbank.js` precedent (`06dd7618`).
- **`73e5d2a3`** — `multiQuery` converted.
- **`31a1d5ad`** — `dataRouter` converted (3 sites; `/taxon_category/` was already
  in-process). Also fixes a **production-crash defect** — see below.
- **`6b1335e4`** — `ExpandingQuery` converted (`runJoinQuery`, `runSDISubQuery`). Fixes the
  **same abort from a second route** and a live cross-collection-download break; see below.
- **`3fc64ead`** — wall-clock deadline in `util/http.js`. See "Outbound request timeouts"
  below; that section's two gaps are now closed.

That is the whole of the branch's code scope. **All three hot-path self-callers
(`multiQuery`, `dataRouter`, `ExpandingQuery`) are converted**; the remaining `http_port`
matches are `app.js`'s own `listen`, the 10 deferred RPC sites, `bundler/genome.js:10`, and
`util/featureSequence.js:12,29`. Status table and pickup instructions are at the top of the
plan.

Two invariants for anything built on `internalQuery`:

- **`user` is explicit at every call site; `publicFree` defaults.** Neither default is safe
  for `user` — `multiQuery` forwards the caller's identity, while `/data` must stay anonymous
  because its `apicache` key is **not user-scoped**, so inheriting an identity would leak
  private counts into a shared cache. `publicFree` defaults because `buildPermissionFq`
  fails **closed** without it and would silently over-filter exempt collections.
- **The collection allowlist must be reinstated.** The HTTP path gates it at `app.js:187`
  via `app.param('dataType')`; callers build the target from client-supplied input, so
  bypassing HTTP would otherwise allow a query against an arbitrary Solr core.

A third invariant, learned in step 6: **`lib/internalQuery.js` must not require anything
under `middleware/`.** Doing so closes a cycle through `ExpandingQuery`, and the cycle is not
benign — `RQLQueryParser` assigns `module.exports = function (…)`, replacing the exports
object, so whichever module loads first captures a stale `{}` for its partner and the failure
surfaces only when a query needs it. That is why `sanitizeErrorMessage` lives in
`lib/sanitizeErrorMessage.js` and is merely *re-exported* from `RQLQueryParser`.

The 10 RPC self-call sites are deliberately deferred (the RPC identity model is
client-supplied `params[1].token`, validated only by the inner self-call — see item 4 of
"Five defects" below). `bundler/genome.js` and `util/featureSequence.js:12,29` also
self-call and were never in the 17-site tally; they carry the same `JSON.parse` shape.
`bundler/genome.js` is still unaudited; `util/featureSequence.js:29` turned out to be dead
code (item 5).

#### `JSON.parse` on a self-call body is how a worker dies

The self-calls are not only slow — one of them has been **aborting production workers**, and
the mechanism generalizes to every remaining site. Chain, verified end to end locally:

1. `util/http.js`'s `httpRequest` **discards `res.statusCode`** and resolves the body either
   way. An inner error response is the plain-text `"A Database Error Occured: …"`, not JSON.
2. `JSON.parse(body)` throws a `SyntaxError` **inside a promise**.
3. If that promise has no rejection handler, the rejection is unhandled.
4. `--unhandled-rejections=strict` (set in `package.json`'s `start`) turns it into an
   `uncaughtException`, which **`app.js:34` swallows and continues past**.
5. The request never reaches `next()` — it **hangs forever holding a worker slot**.
6. `async_hooks` state is now corrupt, and the **next** Solr-backed request aborts the
   process: `node::AsyncHooks::push_async_context … Assertion failed: (trigger_async_id) >= (-1)`.

Reproduced **3/3** on the dev server from two unauthenticated GETs, with a control run
confirming neither alone is sufficient:

```bash
curl 'http://localhost:23001/data/distinct/genome/host_group?q=foo%3A%28'   # hangs
curl -H 'Accept: application/solr+json' http://localhost:23001/data/taxon_category/  # aborts
```

The 22 native frames match `api.err.crash-162500` exactly, and the production log lines
immediately before that abort are `dataRouter.js:60` and `:157` self-calls timing out at 120s.

**`ExpandingQuery` had the same defect, and it did not need a malformed *outer* query.**
`runJoinQuery` did `JSON.parse(body).facet_counts.facet_fields[field]` inside the **success**
handler of a `.then(ok, fail)` pair — which `fail` does not catch — so a sub-query error took
the identical path. Three ordinary client mistakes each killed the worker 3/3, unauthenticated,
one request apiece: an undefined field in the sub-query, an unknown sub-query collection, and
a smuggled `shards` parameter (the sanitizer *correctly* 400s that one; the 400 is what did
the damage on the way back). Note the second variant of the chain — when the body *is* valid
JSON, `JSON.parse` succeeds and the `.facet_counts` dereference throws instead. Same outcome.
Fixed in step 6; regression test is `tests/test-api/test.expanding-errors.spec.js`, which
takes the pre-conversion worker down on its first case.

**Fixed in `dataRouter` by `31a1d5ad` and in `ExpandingQuery` by step 6; the pattern is still
live elsewhere.** Other `JSON.parse`-on-a-self-call-body sites, each needing the same audit —
three questions, because there turned out to be three ways in: does its promise have a
rejection handler, is the parse in the `ok` or the `fail` arm, and **does its `catch`
actually `return`?**

`rpc/proteinFamily.js:51,118,131` · `rpc/msa.js:28` ·
`rpc/biosetResult.js:27,52` · `rpc/transcriptomicsGene.js:30,95,97,141,146,166,247` ·
`routes/indexer.js:151` · `bundler/genome.js` · `util/featureSequence.js`

**`rpc/transcriptomicsGene.js:141` is the worked example of the third question, and it is
live — it took the dev worker down during step 7's test runs, on both codepaths.**
`readPublicExperiments` wraps everything in `new Promise(async (resolve, reject) => …)`, an
async executor, so anything thrown inside becomes an unhandled rejection of the inner async
function rather than rejecting the outer promise. Then:

```js
let response
try {
  response = JSON.parse(res)
} catch (err) {
  reject(new Error(`readPublicExperiments(): Error parsing JSON from SOLR: ${err}`))
}          // <- no return; execution continues

const numFound = response.response.numFound   // response is undefined -> TypeError
```

The `catch` looks like it handles the error. It rejects, but it does not `return`, so control
falls straight through to a deref of `undefined`. The resulting `TypeError: Cannot read
properties of undefined (reading 'numFound')` then takes the documented six-step path to an
aborted worker. Observed identically in the pre-change and post-change logs; step 7's deadline
did not cause it, it only made it fire sooner by letting the caller give up and issue the next
Solr-backed request. Deferred with the rest of the RPC sites — but of the deferred set this is
the one with a confirmed live abort.

Two things make this worse than it looks. `app.js:34` swallowing `uncaughtException` converts
a clean crash into silent state corruption that surfaces later on an unrelated request, so
the stack trace never names the guilty route. And an `if` with no `else` around a response —
there were two in `dataRouter` — hangs by exactly the same mechanism without any exception at
all.

#### All `/data/*` counts are public-data-only

`dataRouter`'s sub-queries run with **`user: undefined`**, matching the hardcoded
`Authorization: ''` of the HTTP version they replaced. Private rows are never counted, for
any caller, authenticated or not.

**Do not "fix" this by forwarding the caller's identity.** Three of the four endpoints are
wrapped in `cacheWithRedis('1 day')` whose key is `req.originalUrl` with `appendKey: []` — it
is **not user-scoped**. An identity reaching these queries would publish one user's private
counts to every subsequent requester for 24 hours. Making these counts private-aware requires
scoping the cache key first.

**One exception to the heading, and it cuts the other way.** `/taxon_category/` does not use
`subQuery` at all — it hand-assembles its own chain and skips `DecorateQuery`, so it is not
public-only, it is **unfiltered**. See item 2 of "Five defects found during this work" below.
The `subQuery` doc comment in `routes/dataRouter.js` says "ALL /data/* COUNTS ARE
PUBLIC-DATA-ONLY"; read that as scoped to `subQuery`'s three consumers, which is where it
sits.

#### `join()` identity, and the two expanders that differ

The RQL expanders in `ExpandingQuery.js` do **not** share one identity policy. Each choice is
deliberate:

- **`runJoinQuery` forwards the caller** (`opts.req.user`), preserving what the self-call did
  with `opts.req.headers['authorization']`. A user joining against their own private genomes
  must still see them.
- **`runSDISubQuery` is pinned anonymous** (`user: undefined`). It *looks* like it forwarded,
  but its only call site passes no `opts` at all, so it always was; `ppi` is `publicFree`, so
  today this is moot either way. It is pinned explicitly, with a comment, rather than
  silently promoted.

Two behavior notes for this file:

- **A failed `join()` sub-query now returns 400** rather than degrading to
  `in(field,(NOT_A_VALID_ID))` → HTTP 200 with zero rows. Nothing was lost: before the
  conversion every reachable error *hung* instead of degrading. `GenomeGroup()` and
  `FeatureGroup()` **keep** their degradation — that path is reachable and clients depend on
  the empty answer. `tests/test-api/test.expanding-errors.spec.js` pins both.
- **A broad `join()` can pin the event loop.** `join(genome,eq(genome_status,Complete),genome_id)`
  facets to tens of thousands of ids and parsing the resulting `in(genome_id,(...))` took the
  dev server to 3.3 GB RSS with `/health` unanswerable. This is the RQL parse, not the
  transport, so the conversion neither caused nor cured it — see
  `PLAN_SOLR_OVERLOAD_PROTECTION.md`.

#### `ResolveQuery` needs the real `req`, not `{}`

`ExpandingQuery.ResolveQuery(rql, { req, res })` reads `req.user` (permission scope for join
sub-queries) and `req.headers.authorization` (the Workspace API). Passing `{}` used to throw a
`TypeError` on the unguarded `req.headers` deref, inside an unwatched promise — which killed
the process. That is fixed, but the trap moved rather than vanished: with the guard in place,
`{}` now resolves **anonymously and silently**, dropping the caller's private rows.
`middleware/CrossCollectionSource.js` was the one caller doing this, so **every
cross-collection download whose source filter contained `join()`/`GenomeGroup()`/
`FeatureGroup()` was broken**; it now threads the real `req`. Any new caller must too.

#### Five defects found during this work and deliberately NOT fixed

Each was found while auditing the self-call sites, each is out of the branch's scope, and
each was re-verified against the code on 2026-08-27. They are recorded here because the
next person to touch these files needs to know, and because two of them are worse than
their one-line descriptions suggest.

**1. `rpc/proteinFamily.js`'s `pfs_` cache serves one user's private genome to the next.**
This is the one to fix first. `fetchFamilyDataByGenomeId` (`:96`) keys Redis on
`'pfs_' + genomeId` with **no user scoping**, while the fetch that populates it forwards
`options.token` (`:114`) and therefore runs permission-scoped. So the cache is written with
one identity and read with any other, for a 24-hour TTL:

- owner requests a private genome → `pfs_<id>` holds its `pgfam_id`/`plfam_id`/`figfam_id`/
  `aa_length` rows → any anonymous caller asking for the same `genomeId` reads them back;
- and in the other direction, an anonymous request caches the empty public answer, after
  which the owner gets zero rows for their own genome until the TTL expires.

This is the **identical shape** as the enrichment leak under "Permission scoping" below —
process-wide cache, unscoped key — which is documented there as a real, live cross-user
read that was fixed. The fix is the same: prefix the key with `permissionScopeKey()` from
`lib/permissionFilter.js`. It is deferred only because it sits behind the RPC identity model
(item 3), not because it is theoretical. Note the RPC endpoint is unauthenticated at the
route level, so no login is needed to read a warm cache.

`fetchFamilyDescriptionBatch`'s cache (`:22,:53`, keyed on bare `family_id`) is **fine** and
should not be "fixed" alongside it: `protein_family_ref` is public reference data and that
fetch sends no `Authorization` at all.

**2. `routes/dataRouter.js:217` (`/taxon_category/`) queries `genome` with no permission
filter whatsoever.** It hand-assembles `RQLQueryParser → APIMethodHandler → media`, skipping
both `DecorateQuery` and `PublicDataTypes`. It returns only the *keys* of the
superkingdom/order/family facets, so this discloses the taxonomic names present among
private genomes rather than any row content — much milder than item 1, but it is the one
`/data` endpoint where "public-data-only" (see above) is not merely a limitation but an
unenforced one. It is also the only `/data` route with no `cacheWithRedis`, which is why it
has no cache-key problem of its own.

**3. `routes/rpcHandler.js:25` is a dead auth gate.** It tests `methodDef.requireAuth`;
all six RPC modules declare **`requireAuthentication`** (verified: `biosetResult:153`,
`cluster:107`, `msa:231`, `panaconda:63`, `proteinFamily:237`, `transcriptomicsGene:349`).
The property never matches, so the 401 has never fired. Harmless *today* only because every
method declares `false` — the hazard is that setting one to `true` looks like it enforces
authentication and silently does not. Fix the name and the declarations together, or delete
the gate; leaving it is the worst of the three options.

**4. The RPC identity model is client-supplied, which is why those 10 sites are deferred.**
`app.js:144` is `app.post('/', rpcHandler)` with **no auth middleware** — verified, there is
no global one either — so `req.user` is always `undefined` inside RPC. The real identity is
`params[1].token`, forwarded as an `Authorization` header on the inner self-call and
validated only by that self-call's own chain. Converting these to `internalQuery` naively
would drop the token and break private workspace transcriptomics; doing it properly means
validating the token at the RPC boundary first. That is a design change, not a transport
change.

**5. `util/featureSequence.js:24` `_getSequenceDictByHash` is dead code.** Defined, never
exported (`module.exports` at `:84` lists only `getSequenceByHash` and
`getSequenceDictByHash`), never called anywhere in the tree. Its self-call at `:29` is
therefore unreachable, unlike `getSequenceByHash`'s at `:12`, which is live. Worth deleting
rather than auditing.

One incidental payoff of step 7 worth knowing: `rpc/proteinFamily.js:7` gives its self-calls
an agent with **`maxSockets: 1`** — literally the configuration the queue-wait test models.
Concurrent RPC calls serialize behind that one socket, and before `3fc64ead` the queued ones
had no deadline of any kind. They now inherit the `util/http.js` wall-clock deadline even
though the site itself is unconverted.

### Facet counts cannot be corrected inside Solr

Worth knowing before designing anything that merges a second collection into `genome` results
— this is the finding that shapes `PLAN_PRIVATE_METADATA_OVERLAY.md`:

- **`JoinEnrichment` is post-query and page-scoped** (`middleware/JoinEnrichment.js:109`). It
  decorates the ~25 returned rows; Solr computed the facet counts over the entire matched
  DocSet long before that middleware ran.
- **`{!join fromIndex=…}` filters but does not project.** It restricts *which* docs match; it
  cannot change the field *values* Solr counts.
- **Facets bypass the distributed path entirely** (`middleware/DistributedQuery.js:171` returns
  `useDistributed: false` for `facet=true`/`group=true`), so there is no streaming hook either.

So any overlay that changes field values must correct facet counts **arithmetically, API-side,
after the query** — which is only practical when the overlay set is small enough to hold whole
(hundreds, not millions).

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
the rest. Everything else is additive or guard-gated. The table is **provenance for the #189
/ #202 review** — it was written when the whole distributed-query + join subsystem was
net-new against master; PR #202 landed it there, so it is no longer a branch delta. Older
breakdown: `Docs/BRANCH_RISK_ANALYSIS.md`.

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

**Fixed on both sides as of 2026-08-17 — no local patch required any more.** The app side is covered by "Outbound User-Agent" below. The `p3-user` side used to be a hand-edit to `node_modules/p3-user/validateToken.js` that did **not** survive `npm install`; that is obsolete. The dependency is now pinned to `BV-BRC/BV-BRC-UserManagement` (not `PATRIC3/p3_user`), whose `validateToken.js` sends `withUserAgent()` and carries the non-JSON signer guard upstream. **Do not re-apply the old patch.** If authenticated requests start returning only public rows again, check the pinned SHA and re-run the Node probe above rather than reaching for `node_modules`.

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

### Shard pages are POSTs — do not convert them back to GET

`ShardCursorStream` sends each cursor page as a **POST with a form-encoded body**. It was the
last GET in the subsystem carrying a user-sized filter, and that broke `terms()`:

- An RQL `terms()`/`in()` clause over a few hundred feature ids crosses Jetty's default
  **`requestHeaderSize` of 8192 bytes**. The shard answers **`414 URI Too Long`**.
- The client sees **HTTP 200 with a one-byte body, `[`** — `media/json.js` writes the opening
  bracket before the first document arrives, so no mid-stream shard failure can change the
  status code. Same empty-200-on-failure class as the streaming-`sort()` and shard-failure
  defects documented elsewhere in this file.
- Measured ceiling ≈ **148 feature ids** (~55 bytes each). Verified after the fix: 3000 ids,
  a **166 KB** `fq` (~20× the old ceiling), returns 2,338,240 bytes byte-identical to the
  standard path.

Two traps if you touch `_buildQueryParams`:

- **Parse the caller's fragment, don't concatenate it.** `URLSearchParams` decodes it exactly
  as Solr decodes a query string (`+`→space, `%XX`→byte) and re-encodes it for the body, so
  Solr local params like `{!terms f=x}` and values containing spaces survive intact.
- **`append()`, not `set()`, for caller params, and only default `q=*:*` when the caller has
  none.** Repeated `fq=` must all survive, and an unconditional `q=*:*` produces a duplicate
  `q=` and an empty result set when the RQL constraint landed in `q=` rather than `fq=`.

This bug only bites where `distributedQuery.enabled` is true. Production sets it `false`, and
`in()` never reached the path at all — `Limiter.detectFixedIdCount` caps a fixed-id query's
limit to `idCount + 10`, dropping it below `minLimitThreshold` (10000). `feature_sequence` is
likewise immune because it is not in `enabledCollections`.

`terms()` used to be the exception that let a user-sized filter through; as of the
`detectFixedIdCount` change it is capped the same way, so **nothing in normal use reaches this
code path with a large filter any more**. That makes the gate below the only thing holding the
regression down — do not delete it on the grounds that the bug is unreachable.

Gate: `tests/test-distributed/test.shardcursor-post.spec.js` (9 tests, fully offline against a
stub Solr; all 9 fail against the pre-change module).

### The merge comparator must match Solr's byte order, not ICU collation

**`MinHeap.compareUtf8` exists because `localeCompare` silently misordered sorted distributed
results.** Solr sorts string fields on their indexed BytesRef, which Lucene compares as
**unsigned UTF-8 bytes**. `localeCompare` is ICU collation and orders by base letter, ignoring
case at the primary level, so the two disagree: ICU puts `misc_feature` before `misc_RNA`,
Solr puts `misc_RNA` first (`R` 0x52 < `f` 0x66).

That only matters because each shard arrives **already sorted by Solr** — `MergeSortStream`'s
k-way merge is only correct if its comparator agrees with the order its inputs came in.
Disagreement interleaves correctly-sorted shards into a wrongly-ordered output. A live
`sort(+feature_id)&limit(25000)` returned **7 out-of-order positions** in 25,000 rows against
a monotonic standard-path response.

Anything comparing sort-field values must go through `MinHeap.compareUtf8`. It is not simply
`Buffer.compare`: JS `<` is UTF-16 code-unit order, which is *identical* to UTF-8 byte order
for any string without a surrogate pair, so the common case is handled natively and only
strings carrying a supplementary character fall back to an explicit byte compare. That
matters — `Buffer.compare` on every comparison measured **10× slower than the `localeCompare`
it replaces** (1071 vs 107 ns), while the guarded form is 123 ns, i.e. free. The fallback is
not decorative: UTF-8 sorts supplementary characters above all BMP code points, whereas their
UTF-16 surrogates (0xD800–0xDBFF) fall below the 0xE000–0xFFFF range, so plain `<` gets emoji
vs. private-use characters backwards.

Verified live after the fix, distributed vs standard path, **byte-identical documents** in
every case: `sort(+feature_id)`, `sort(+feature_type)` (the field carrying the
`misc_RNA`/`misc_feature` collision), `sort(+product)` (free text), a descending sort, and a
3000-id `terms()` filter combined with a mixed-case sort. Each previously had out-of-order
positions or, for the last, failed outright.

Gate: the `compareUtf8` and mixed-case cases in `tests/test-distributed/test.minheap.spec.js`
(6 tests, offline; all 6 fail against the pre-change comparator, and the 23 pre-existing tests
in that file pass either way — none of them encoded the ICU behavior).

Note this fix does **not** touch missing-value ordering. `fieldComparator` sorts
`null`/`undefined` last on ascending, which is Solr's `sortMissingLast` behavior but not its
universal default; if a sorted distributed query ever disagrees with the standard path on rows
missing the sort field, that is where to look.

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

**`eslint` 7 → 8 does not work.** `eslint-config-standard@12` and `eslint-plugin-import@2.22`
both pin peer `eslint@"^2 || … || ^7.2.0"`, so npm fails with `ERESOLVE`. Upgrading eslint
means upgrading the whole standard/plugin stack together and re-running lint (56 pre-existing
errors would shift). Not worth bundling into a dependency refresh — do it on its own.

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

## Outbound request timeouts — both gaps now closed

The recurring failure mode in this codebase is an **outbound HTTP call with no deadline**. A
connection that is accepted but never answered (classically a pooled keepAlive socket the far
side has already dropped — a silent drop leaves no FIN, so the socket cannot be probed before
use) hangs until the OS tears down the TCP session. Measured at ~166s in
`Docs/GENBANK_DOWNLOAD_PERFORMANCE.md`; Cloudflare's ~100s origin limit fires first, so the
user sees a **524** while the worker still holds a socket slot.

PR #203 added `SOLR_REQUEST_TIMEOUT_MS` (default 120000) to the main data path.
`middleware/APIMethodHandler.js` builds all its Solr clients through `makeSolrClient()` so no
path can miss it, and `armTimeout()` in `lib/solrjs/index.js` now covers `query`, `get`,
`getSchema`, and the streaming path (previously only `query` honored `this.timeout`).

**Two gaps were found, both verified by experiment 2026-08-25:**

1. **A socket timeout does not bound time spent queued for a socket.** `req.setTimeout` only
   starts once the agent assigns a socket. Tested with `maxSockets: 1` against a black-hole
   server: a request with a 2000 ms timeout was **still pending after 6000 ms**. With
   `maxSockets: 8`, anything that slows Solr fills the pool and request 9 waits with no timer
   running — worst case is *(unbounded queue wait) + 120s*.
2. **`util/http.js` had no timeout mechanism at all** — not merely unset, absent. It carries
   the Workspace API calls and all 17 self-call sites.

**Both are fixed in `util/http.js` by `3fc64ead`** (step 7 of `PLAN_ELIMINATE_SELF_CALL.md`)
with a wall-clock deadline armed at request *creation* — a plain `setTimeout`, deliberately
**not** `req.setTimeout`, which is what makes gap 1 go away: one number covers queue wait,
connect, TLS, write, and response body.

- `HTTP_REQUEST_TIMEOUT_MS`, default 120000, matching `SOLR_REQUEST_TIMEOUT_MS`.
- Per-call override via `options.timeout`; **`timeout: 0` disables** the deadline entirely,
  for a caller that genuinely wants to wait.
- Rejects with `err.code === 'ETIMEDOUT'` and destroys the request so the socket is released.
  The message names host and path with the **query string stripped** — these reach clients,
  and a self-call path carries the caller's filter.
- All 10 async helpers are covered; the non-async `requestUrlForUrl` is not.

Two things to preserve when touching this file. The timer must be cleared on **both** settle
paths — mocha runs without `--exit`, so a leaked 120s timer stalls an entire suite rather
than failing one test. And `tests/test-util/test.userAgent.spec.js:126` counts
`'http[a-zA-Z]*':\s*async` against `withUserAgent(options` and requires the two to be equal,
so a new helper needs both the UA merge and the deadline.

Gate: `tests/test-util/test.httpTimeout.spec.js` (9 tests, fully offline — two local servers,
no API/Solr/Redis). 8 of the 9 fail against the pre-change module. The one that matters most
is "the deadline bounds time spent QUEUED for a socket": swap `armDeadline`'s `setTimeout` for
`req.setTimeout` and that test hangs while the other eight still pass.

**Gap 1 still applies to the Solr path.** `armTimeout()` in `lib/solrjs/index.js` remains
`req.setTimeout`-based, so `SOLR_REQUEST_TIMEOUT_MS` does not bound queue wait. Only
`util/http.js` has the creation-time deadline.

Also note `maxFreeSockets: 0` does **not** disable pooling — Node treats `0` as unset and
falls back to its default, so idle sockets are still retained. (Tested; an earlier note in
this file claiming otherwise was wrong.)

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

The `terms(field,(val1,val2,...))` operator generates a Solr
`{!terms f=field cache=false}val1,val2,...` filter query. This uses Solr's hash-set-based terms filter which is much more efficient than the boolean OR tree generated by `in()` for large value lists (hundreds+ values).

```
# Efficient — uses {!terms} hash filter
terms(genome_id,(123.456,789.012,345.678))

# Less efficient for large lists — uses field:(val1 OR val2 OR val3)
in(genome_id,(123.456,789.012,345.678))
```

Use `terms()` instead of `in()` when the value list is large. The `terms()` output goes into an `&fq=` parameter rather than into the main `&q=` query. It is marked `cache=false` — see "Vacating `q=` is the real cost" below; that is load-bearing, not a micro-optimization.

#### The win is `fq` vs `q`, not hash-set vs boolean

The rationale above ("hash-set filter beats the boolean OR tree") is **mostly wrong about the
mechanism**, though the conclusion holds. Measured 2026-09-03 against the production cluster,
direct to Solr, POST, **`rows` held constant** and a **fresh id list per repetition** so
nothing hits the filterCache (min-of-3 QTime ms, `genome_feature`/`feature_id`):

| n | `in()` → `q=` bool | `{!terms}` → `fq=` | `{!terms cache=false}` → `fq=` | bool → `fq=` |
|---|---|---|---|---|
| 100 | 47 | 33 | 50 | 32 |
| 500 | 152 | 71 | 71 | 80 |
| 1500 | 299 | 169 | 158 | 172 |
| 5000 | 925 | 479 | 393 | 357 |

Read the last column against the second: a **boolean OR in `fq` is as fast as `{!terms}`**, and
at n=5000 it is faster. Nearly all of `terms()`'s advantage over `in()` comes from the clause
landing in `fq` (a filter, unscored, no `maxScore` bookkeeping) instead of `q` (scored across
every matching doc). The hash set is close to a wash against Lucene's own boolean rewrite.

Practical consequence: **the same benefit is available to `in()`** by emitting it into `fq`
when the query needs no scoring — a cheaper change than pushing callers onto a second
operator. Not implemented. Note that `detectFixedIdCount` would need the matching pattern
change in the same commit, exactly as it did for `terms()` (see below).

#### Vacating `q=` is the real cost — hence `cache=false`

**List size is not the main variable; whether the id list is the *only* clause is.** This came
from an external harness
(`p3_core/t/client-tests/p3-rql-terms-bench.pl`) and it is correct — reproduced here on the
production cluster. `terms()` moves the id list to `fq` and leaves whatever else the client
sent as the entire scored query:

```
in(feature_type,(mat_peptide,CDS)) & in(feature_id,(6000 ids))
  -> q=(feature_type:(...)) AND (feature_id:(a OR b ...))   one boolean; Solr leads
                                                            with the selective id clause
in(feature_type,(mat_peptide,CDS)) & terms(feature_id,(6000 ids))
  -> q=(feature_type:(...))   fq={!terms f=feature_id}...   scores ~the whole core,
                                                            filters afterwards
```

Their measurement, `patric_id` over 6053 ids: alone `0.86×` (terms faster), plus
`in(feature_type,...)` `1.65×` (terms slower). Two `P3DataAPI` call sites send exactly this
shape — `retrieve_protein_feature_sequence` and `retrieve_nucleotide_feature_sequence` both
carry `in(feature_type,...)`.

Their proposed fix was to move the *remaining* clauses to `fq` too. Measured, it helps but
does not win. `cache=false` on the terms filter does (production cluster, 6000 ids +
`feature_type:(mat_peptide OR CDS)`, `rows` held constant, min-of-2 QTime):

| variant | QTime |
|---|---|
| both as `in()` → one boolean in `q=` | 2418 ms |
| `terms()` as we emitted it (cached filter) | 3952 ms |
| **`terms()` with `cache=false`** | **676 ms** |
| move both clauses to `fq` (their proposal) | 3005 ms |
| terms in `q=`, type clause to `fq` | 3200 ms |

Caching the filter makes Solr materialize its DocSet up front and then drive iteration from
the scored query. Uncached, the terms query is an ordinary scorer inside the intersection and,
being far more selective, **leads** it — which is the whole win, and it is bigger than the
one available by relocating clauses. Note the cached figure does **not** improve on a repeat of
the same id list: the cost is the scoring, not building the filter, so a filterCache hit does
not rescue that shape.

Standalone (no co-occurring clause) the two are a wash — 33/31, 74/80, 178/174 ms at
n=100/500/1500, min-of-5, fresh id list per rep — so this gives up nothing in the simple case
and it stops one-shot id lists from evicting reusable entries from the filterCache. An earlier
note here read a 50-vs-33 sample as evidence against a blanket `cache=false`; that was noise.

Emitted by `lib/solrjs/rql.js`; gate is `tests/test-util/test.rql-terms-cache.spec.js` (6 tests,
offline; 4 fail against the pre-change emitter). The remaining trade is a client that re-sends
an identical `terms()` filter while paging — that pays for the cache. No such caller exists
today: the web grid pages with `in()`, and `terms()` must be written explicitly.

**The other `{!terms}` emitters are deliberately unchanged.** `media/genbank.js:136`,
`rpc/transcriptomicsGene.js:233,253` and `lib/distributed/DirectSolrClient.js:280` all pair
their filter with `q=*:*`, so there is no scored query for the filter to lose a race against
and the degradation mechanism does not apply.

**A client-supplied Solr-format `{!terms}` does not get `cache=false`, and that gap is real.**
`RQLQueryParser` returns early for `queryType === 'solr'` (`:68`), and neither
`SolrQuerySanitizer` nor `SolrQueryParser` touches `fq` at all (zero `terms` references in
either). So a request sent as `application/solrquery+x-www-form-urlencoded` carrying its own
`fq={!terms f=…}` keeps Solr's default *cached* filter, and if it also carries a scored `q=`
it lands on the slow shape above. Left alone on purpose: rewriting an explicit client local
param is a different call from choosing what our own emitter produces, and a client paging
with a repeated identical filter genuinely wants the cache. Nothing in-tree is affected —
the four emitters above bypass this chain and all pair with `q=*:*`.

**Routing is *not* part of that gap.** `detectFixedIdCount`'s pattern is
`\{!terms\b([^}]*)\}` — the cache directive is deliberately not required, pinned by
"recognizes the filter without the cache directive" in
`tests/test-util/test.limiter-terms.spec.js`. A bare Solr-format
`fq={!terms f=feature_id}a,b,c,d,e` with `rows=25000` still comes out of `Limiter` at
`rows=15`, hence still below `minLimitThreshold`, hence still on the standard path.

#### The reported small-list slowdown was the distributed path, not `terms()`

The same external report measured `terms()` **2.3× slower at n=100**, shrinking to parity at a
crossover around 15k values on `genome_feature`, and hypothesized per-request overhead in the
`fq` construction. **That hypothesis is wrong, and the numbers are real** — the cause is on our
side but it is not `terms()`.

The harness runs against **alpha, which sets `distributedQuery.enabled: true`**; production and
this dev config set it `false`, which is why it did not reproduce locally at first. `P3DataAPI`
sends `limit(25000)` on every `query_cb` (`chunk_size`). So:

- `in()` is caught by `Limiter.detectFixedIdCount` and capped to `rows = idCount + 10` — below
  `minLimitThreshold` (10000) — and takes the **standard** path.
- `terms()` was invisible to that regex, kept `rows=25000`, and took the **distributed** path.

**Fixed** — `detectFixedIdCount` now recognizes both forms and the two operators get identical
`rows`; see "`detectFixedIdCount` sees both operators" below.

The two operators were never running on the same transport. Confirmed on their own endpoint:
with `rows` held equal, `terms()` is faster there too (0.88× / 0.47× / 0.44× at n=100/500/1500);
at `limit(25000)` it is 5.82× / 3.65× / 2.50× slower and comes back with
`x-distributed-query: true`. The ratio shrinks with n because the distributed path's fixed
setup cost amortizes, and at n=15000 `in()`'s capped 15010 rows also crosses the threshold, so
both go distributed and the ratio lands at their measured 0.95×. That accounts for the
crossover exactly.

With `rows` held constant, `terms()` is faster at every size on both
`genome_feature`/`feature_id` and `feature_sequence`/`md5`, with contiguous *and* scattered id
lists (min-of-3 wall ms, scattered `feature_id`, `limit(n)`): 100 → 117 vs 51, 500 → 342 vs
158, 1500 → 680 vs 355, 5000 → 2696 vs 931. Scattering the ids *widens* the gap in `terms()`'s
favour, which is the expected direction — a boolean rewrite pays per-term dictionary seeks.

Also note a best-of-N harness that reuses **one** id list lets runs 2..N hit the filterCache,
which flatters `terms()` — that design can only understate a `terms()` loss, never invent one.

#### `detectFixedIdCount` sees both operators

`middleware/Limiter.js` recognizes both id-list forms and caps `rows` to `idCount + 10` for
either:

```
in(pk,(a,b,c))     -> q= ... (pk:(a OR b OR c))
terms(pk,(a,b,c))  -> &fq={!terms f=pk cache=false}a,b,c
```

Verified end to end (RQL → `toSolr` → `Limiter`, `genome_feature`, `limit(25000)`): at
n=100/1500/9000/15000 both operators now emit `rows` of 110/1510/9010/15010, so both stay on
the standard path below 15000 and both cross `minLimitThreshold` at 15000. Previously `terms()`
held `rows=25000` at every size.

Three things about the detection worth preserving:

- **It is anchored to `&fq=`.** Only an `fq` is unconditionally ANDed, so only there does the
  value count bound the result set. The `in()` pattern has no such anchor and will happily
  match inside an `or()`, where the count bounds nothing — a **pre-existing** looseness that
  the terms pattern deliberately does not copy.
- **It skips a filter carrying a `separator` local param** rather than comma-counting it. The
  emitter never sets one; skipping leaves `rows` uncapped, which is the safe direction.
- **`cache=false` is optional to the match.** Other emitters and captured queries predate it.

Note this is what exposed the 8 KB shard-fetch ceiling — a `terms()` query used to be the only
way a user-sized `in`-style filter reached the distributed path. It no longer is, so
`tests/test-distributed/test.shardcursor-post.spec.js` is now the only thing holding that
regression down; see "Shard pages are POSTs" above.

Gate: `tests/test-util/test.limiter-terms.spec.js` (13 tests, offline; 8 fail against the
pre-change middleware, and the 5 that pass are the negative cases).

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
- **Pass the real `req` to `Expander.ResolveQuery`, not `{}`.** This call site did the latter, so a source filter containing `join()`/`GenomeGroup()`/`FeatureGroup()` crashed the worker; with that guarded it would instead resolve anonymously and drop the user's own private rows. See "`ResolveQuery` needs the real `req`" above.
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
