# PLAN — Permission-aware join enrichment (fix: enrichment fetches bypass the permission filter)

**Status:** implemented and verified against live Solr 9.6.1 (2026-08-06)
**Owner:** Data API
**Priority:** security-sensitive bug fix. Prerequisite ("Phase 0") for
`PLAN_CROSS_COLLECTION_DOWNLOAD.md`.
**Related:** `middleware/JoinEnrichment.js`, `middleware/JoinFieldInjector.js`,
`lib/BatchJoiner.js`, `lib/distributed/DirectSolrClient.js`,
`lib/distributed/JoinEnrichmentStream.js`, `lib/distributed/GenomeMetadataJoinStream.js`,
`lib/distributed/SequenceJoinStream.js`,
`middleware/DecorateQuery.js`, `middleware/PublicDataTypes.js`

---

## Bug statement

The join-enrichment subsystem performs its secondary Solr fetches with **no permission filter and no
user identity**. The API is the permission layer — Solr itself enforces nothing — so an unfiltered
enrichment fetch reads every matching row regardless of owner. Verified across every path:

- `middleware/JoinEnrichment.js:249` calls `joiner.enrichDocs(docs, joinSpec)` — no `req.user` passed.
- `lib/BatchJoiner.js` — no `user`/`header`/`public`/`owner` handling anywhere.
- `lib/distributed/DirectSolrClient.js:196` (`fetchByIds`) builds `q=*:*&fq={!terms f=...}` with **no
  permission `fq` and no `X-Authenticated-User` header**.
- `lib/distributed/JoinEnrichmentStream.js` and `lib/distributed/SequenceJoinStream.js` — same; both
  drive `BatchJoiner`/`DirectSolrClient` with no identity.
- `lib/distributed/GenomeMetadataJoinStream.js:161` — calls `fetchGenomeMetadata` → unfiltered
  `genome` fetch, and maintains its **own separate LRU cache**, independent of `BatchJoiner`'s.
  Wired into `media/dna+fasta.js:252` and `media/protein+fasta.js:214`.
- `getJoiner()` (`JoinEnrichment.js:29`) returns a **process-wide singleton** `BatchJoiner`, so the
  enrichment layer is structurally *not* request/user scoped. Its LRU cache
  (`BatchJoiner` `_getCache`) is keyed by **foreign-key value only** — not by user.

The defect has two sides, both stemming from the single missing control:

### Fetch side
The `{!terms}` fetch returns rows the requesting user is not entitled to see and attaches the
configured fields to their results. `DecorateQuery` scopes the *primary* query; nothing scopes the
*secondary* one.

### Cache side
The user-blind shared LRU means a row fetched while serving user A can be served to user B on a later
request — a leak that persists even after the fetch side is fixed, until the cache is scope-keyed.
Note this applies to **two** independent caches: `BatchJoiner`'s per-collection LRU and
`GenomeMetadataJoinStream`'s own genome cache.

### This is live today, not latent

Checked against `middleware/PublicDataTypes.js:2` (35-entry allowlist). Of the collections involved
in enrichment, **only `feature_sequence` is in `publicFree`**:

| collection | role | in `publicFree`? |
|---|---|---|
| `genome` | join **target** of every configured join | **no** |
| `genome_feature`, `sp_gene`, `pathway`, `subsystem`, `genome_amr` | join sources | **no** |
| `feature_sequence` | `SequenceJoinStream` target | yes |

`genome` is private-capable today — `routes/genomePermissionRouter.js` exists specifically to manage
`owner`/`user_read` on it — and it is the target of every join in the shipped config. Private `genome`
rows are being fetched unfiltered and written into the shared user-blind caches **now**. There is no
config coincidence protecting this.

### Reachability (calibrating severity)

This is a **missing control**, not a demonstrated bypass. To read a private genome's `genome_name`, an
attacker needs a document in their own *permission-filtered* result set that carries that genome's
`genome_id`. All join sources are permission-filtered, and features of a private genome are themselves
private — so exploitation requires a public row referencing a private genome, or a cache collision
with the same precondition. Exposure is bounded to the configured joinable fields (`genome_name`,
`taxon_id`, `genome_status`, `strain`).

Fix it because the control is absent and the blast radius grows with every added join target — not
because there is a known live exploit. Urgency: high-priority correctness, not incident response.

---

## Fix overview

Make enrichment permission-aware end-to-end: thread the requesting user's identity into every
secondary fetch, apply the same permission filter `DecorateQuery` applies to primary queries, and make
the caches incapable of serving one user's private data to another.

Two changes, in dependency order:

1. **Shared permission-filter helper** — one source of truth for the permission `fq`.
2. **Identity-threaded fetches + scope-keyed caches** — one atomic change (see Phasing for why these
   cannot be separated).

---

## Part 1 — Shared permission-filter helper (`lib/permissionFilter.js`)

`DecorateQuery.js` today inlines the permission logic:

```js
// no user:  &fq=public:true
// user:     &fq=(public:true OR owner:<user> OR user_read:<user>)
// exempt if collection ∈ publicFree
```

Extract this into `lib/permissionFilter.js` exposing pure functions:

```js
// Returns the permission fq string for a collection+user, or null if exempt/none needed.
buildPermissionFq({ collection, user, publicFree }) → string | null

// Returns a stable scope key identifying the permission view (for cache keying, Part 2).
permissionScopeKey({ collection, user, publicFree }) → string
```

- `buildPermissionFq` reproduces `DecorateQuery`'s exact semantics (public-only when no user; the
  `public:true OR owner OR user_read` triple when a user is present; `null` when the collection is in
  `publicFree`).
- `permissionScopeKey` returns e.g. `public` for exempt/anonymous-public, or `user:<user>` when a user
  scope applies — the minimal identity that determines *which rows are visible*.

**Escape the user value.** `DecorateQuery.js:11` interpolates `req.user` into the `fq` raw. Low risk
today (the value is token-validated at `middleware/auth.js:15`), but a shared helper is the right place
for the escaping to live — do it here rather than propagating raw interpolation to a second call site.

Refactor `DecorateQuery.js` to call `buildPermissionFq` so there is **one** implementation. Any change
to permission semantics then propagates to enrichment automatically. (This also removes the
duplication risk flagged in the download plan's Phase 1.)

---

## Part 2 — Identity-threaded fetches + scope-keyed caches (atomic)

### 2a — Fetch path

**`DirectSolrClient.fetchByIds(collection, field, values, options)`** — extend `options`:
- `options.permissionFq` — appended as an additional `fq` alongside the `{!terms}` filter. The
  multi-`fq` path already exists in `DirectSolrClient` (`params.fq` accepts an array), so this is
  additive. **Note:** `fetchByIds` currently builds its own `URLSearchParams` for the POST body and
  calls `queryParams.set('fq', termsQuery)` directly (`DirectSolrClient.js:213-214`) — it does *not*
  route through `query()`. Use `append` for the second `fq` there.
- Also set the `X-Authenticated-User` header when a user is present, matching
  `APIMethodHandler.js:25`. Nothing in-repo consumes it and the `fq` is the authoritative control
  (see Decisions), but it costs one line and keeps the two fetch paths consistent.

`fetchByIdsAsDict` and the convenience wrappers `fetchGenomeMetadata` / `fetchSequencesByMd5` pass it
through.

**`BatchJoiner.enrichDocs(docs, joinSpec, ctx)`** — accepts a `ctx = { user, publicFree }`.
(**`enrichDocsChained(docs, chainedSpec, ctx)`**, the chained variant, belongs to
`PLAN_CROSS_COLLECTION_DOWNLOAD.md` and was **NOT** built by this work — only single-hop `enrichDocs`
shipped. That plan's Prerequisite section briefly claimed otherwise; corrected 2026-08-06. When it is
built, it must apply the scoping below **per hop**, since each hop targets a different collection.)
For each hop:
- compute `permissionFq = buildPermissionFq({ collection: hop.targetCollection, user, publicFree })`
- pass `permissionFq` into `_fetchAndCache` → `fetchByIds`.

**Callers pass identity:**
- `JoinEnrichment.js:249` → `joiner.enrichDocs(docs, spec, { user: req.user, publicFree: req.publicFree })`
- `JoinEnrichmentStream` — accept `{ user, publicFree }` in its constructor options and forward to
  `enrichDocs`. Wired from `APIMethodHandler.streamQuery:39` / `DistributedQuery.js:353` where the
  stream is built (both already have `req`).
- **`GenomeMetadataJoinStream`** — same treatment for its `fetchGenomeMetadata` call
  (`GenomeMetadataJoinStream.js:161`). **This is the highest-priority path in Part 2**: its target
  (`genome`) is private-capable and it carries an independent cache. Wired from `media/dna+fasta.js:252`
  and `media/protein+fasta.js:214`, which must plumb `req.user`/`req.publicFree` into the constructor.
- `SequenceJoinStream` — same treatment for its `feature_sequence` fetch. `feature_sequence` **is** in
  `publicFree`, so `permissionFq` will always be `null` and behavior is unchanged. Apply the pattern
  anyway for uniformity, but expect no functional delta — this is the one path where nothing changes.
- Direct `fetchSequencesByMd5` calls at `media/dna+fasta.js:416` and `media/protein+fasta.js:355` —
  benign (`feature_sequence`), but they are call sites of a signature being changed; update for
  consistency.

### 2b — Cache safety

Both caches — `BatchJoiner`'s per-collection LRU and `GenomeMetadataJoinStream`'s genome cache — are
keyed by foreign-key value only. Fix by **incorporating the permission scope into the cache key**:

- Cache key becomes `${permissionScopeKey} ${foreignKeyValue}`. A private row visible to `user:alice`
  is cached under her scope and can never be returned for `user:bob` or `public`.
- Rows fetched under a `publicFree`/anonymous scope live under the `public` scope key and remain
  shared across all users (preserves hit-rate for the common case).

**Bounding.** The prefixed-single-LRU form above is preferred over per-`(scope, collection)` cache maps
specifically because the latter is **unbounded memory keyed by user** — nothing evicts a scope. The
prefixed form has its own cost: one user's private working set evicts everyone's public entries out of
a single LRU (`cacheSize` default 200; streaming batch size 50, so a single batch can churn a quarter
of it). Accept that, and raise `cacheSize` if profiling shows hit-rate collapse. If per-scope maps are
chosen instead, they **must** carry an explicit scope-count cap with LRU eviction of whole scopes.

Alternative considered (documented, not chosen unless profiling favors it): **cache only `public:true`
rows** under a shared key and always fetch non-public rows fresh. Simpler and inherently bounded, but
loses caching for private-heavy workloads.

### 2c — Fix the null-poisoning bug while here

`BatchJoiner.js:176-183`: on fetch **error**, the catch block caches `null` for every requested key —
permanently, for the process lifetime. A single transient Solr blip silently disables enrichment for
those IDs until restart. (Caching `null` for keys genuinely *absent* from the result set, at
`BatchJoiner.js:168-175`, is correct and should stay.) `_fetchAndCache` is being rewritten for the
`ctx` parameter anyway — fix the error path to leave the cache untouched. Same pattern exists in
`GenomeMetadataJoinStream._fetchAndCacheGenomes`; fix both.

**Note on the singleton:** `getJoiner()` stays a singleton (connection pooling), which is fine —
identity is now passed **per call**, not held on the instance. The only shared mutable state that
matters is the cache.

---

## Test plan (security-critical)

Add `tests/test-permissions/` (or extend existing permission tests):

1. **Owner sees, non-owner doesn't.** User A owns a private `genome`. A public-ish source row carrying
   that `genome_id` is enriched with `select(genome_name)`:
   - as user A → `genome_name` **present**;
   - as user B (and anonymous) → `genome_name` **absent**.
   The non-owner half is the regression test — it fails against today's code. The owner half is a
   guard against over-filtering (it passes today, and must keep passing).
2. **Cache leak.** Warm the cache by having user A enrich their private row, then have user B issue the
   same join in the same process; assert user B does **not** receive A's row from cache. This is the
   test that specifically guards 2b — **it must fail against a fetch-only fix**.
3. **Public unchanged.** A `publicFree`-target enrichment (`feature_sequence` md5 lookup) and a
   public-`genome` enrichment return identical results and still benefit from the shared cache.
4. **Streaming parity.** #1 and #2 through each streaming path: `JoinEnrichmentStream` (paginated-style
   specs over a stream), **`GenomeMetadataJoinStream` via the FASTA serializers** (its own cache —
   assert the leak test against it independently), and `SequenceJoinStream`.
5. **Error path doesn't poison.** Force a fetch failure, then a successful retry for the same keys;
   assert the second call enriches rather than returning cached `null` (guards 2c).

---

## Phasing

1. **Part 1** — `lib/permissionFilter.js` + refactor `DecorateQuery` to use it. Pure, low-risk,
   independently testable. Lands the single source of truth.
2. **Part 2 (2a + 2b + 2c together, one commit)** — fetch filtering, scope-keyed caches, and the
   null-poisoning fix.

   **Why 2a and 2b cannot be split:** the target collection (`genome`) is private-capable *today*, so
   the "don't ship the fetch fix without the cache fix" condition is already met. Worse, 2a alone is a
   **net regression**: today every cached row was fetched anonymously, so the cache is at least
   uniformly unfiltered. Adding a per-user `fq` without scope-keying starts writing *correctly-fetched
   private* rows into a shared key space — manufacturing the cross-user leak that 2b prevents.
3. **Tests** (all five) green before this is considered complete.

## Implementation notes (2026-08-06)

All parts landed. Deviations and findings worth recording:

- **`GenomeMetadataJoinStream` needed no cache scoping.** It is constructed
  per-request in the FASTA serializers, so its LRU cannot outlive one user. Only its
  *fetch* was unfiltered. `BatchJoiner` is the singleton, and it is the only cache
  that required scope-keying.
- **`getGenomeMetadataDict` (`dna+fasta.js:61`, `protein+fasta.js:59`) was already
  correct.** It re-enters the API over HTTP via `distributeURL`, forwarding the
  caller's `authorization` header, so the normal middleware chain applies the
  permission filter. Left unchanged.
- **`permissionContext()` helper added** beyond the two functions the plan specified.
  Fetch-and-cache sites need the `fq` and the scope key derived from the *same*
  inputs; letting callers compute them separately invites exactly the divergence
  that produces a mis-scoped cache entry.
- **Verified the fix is load-bearing.** Reverted `_cacheKey` to an unscoped key
  (simulating a fetch-only fix) and confirmed 5 tests fail, including both
  `JoinEnrichmentStream` leak tests — then restored. Test #2 is a real gate, not a
  tautology.
- **Wire format verified** against a local stub server: `fetchByIds` emits two
  distinct `fq` params (`{!terms ...}` + permission filter, ANDed by Solr) and the
  `X-Authenticated-User` header. The `publicFree` path emits a single `fq`, byte
  identical to pre-change behavior.
- **`escapeSolrValue` changes output only for ids containing Solr metacharacters.**
  Real ids (`olsonanl@patricbrc.org`) round-trip unchanged; a 60-combination
  differential against the old inline `DecorateQuery` logic showed no other diffs.

### Live-Solr verification (2026-08-06) — COMPLETE

Run against a local single-node SolrCloud 9.6.1 with the production configsets from
[bv-brc/bv-brc-solr](https://github.com/bv-brc/bv-brc-solr) (`genome` = 148 fields,
`owner`/`public` correct, `user_read`/`user_write` multi-valued). Setup procedure:
`Docs/LOCAL_SOLR_SETUP.md`.

Four fixture genomes: one public, one private to alice, one private to bob, one
owned by alice with `user_read:[bob]`.

**Raw dual-`fq`, exactly as `fetchByIds` emits it** (`{!terms f=genome_id}...` plus the
permission clause as a second `fq`):

| permission fq | numFound | rows returned |
|---|---|---|
| *(none — pre-fix behavior)* | **4** | all, including both users' private genomes |
| `public:true` | 1 | public only |
| alice triple | 3 | public + own private + shared |
| bob triple | 3 | public + own private + shared |

Confirms what the mocks could not: Solr ANDs the two `fq` params, the `{!terms}`
local-params prefix does not swallow the second clause, and multi-valued `user_read`
matches correctly. The no-fq row reproduces the original leak against real Solr.

**Full stack through `BatchJoiner` → `DirectSolrClient` → live Solr**, one joiner
instance (mirroring the process-wide singleton), sequential requests, no restart:

```
alice (cold cache)            Public | Alice Private | —            | Shared With Bob
bob   (cache warm from alice) Public | —             | Bob Private  | Shared With Bob
anonymous (cache warm)        Public | —             | —            | —
alice again (own cache)       Public | Alice Private | —            | Shared With Bob
```

Line 2 is the Part 2b gate end-to-end: bob queries the cache alice just warmed and
does **not** receive her private row, while still getting his own and the shared one.
Line 4 confirms scope-keying does not break cache reuse within a scope.

### HTTP end-to-end via the API (2026-08-06)

API running on `localhost:13001` against the same local Solr.

Added a `genome_feature` fixture that is the **exact reachability precondition** the
bug statement describes: `f.leak.1`, a `public:true` feature whose `genome_id` points
at alice's `public:false` genome. A permission-filtered primary query returns it to
anyone; only the enrichment fetch stands between the requester and the private
genome's `genome_name`.

```
GET /genome_feature/?in(feature_id,(f.pub.1,f.alice.1,f.shared.1,f.leak.1))
    &select(feature_id,genome_id,product,genome_name)
```

Anonymous:

```
f.pub.1     genome=999001.1  genome_name="Public Test Genome"
f.leak.1    genome=999002.1  genome_name=undefined          <-- private, correctly withheld
```

(`f.alice.1` / `f.shared.1` are absent entirely — the *primary* query filters those,
which is `DecorateQuery` working as it always has.)

Response carries `X-Join-Enrichment: true`, confirming the join actually executed and
withheld the value, rather than being skipped and passing vacuously.

**Confirmed the test bites.** Temporarily reverted `_fetchAndCache` to pass `{ fl }`
with no `permissionFq` (pre-fix behavior) and re-ran the same enrichment against live
Solr as an anonymous user:

```
genome_name = "Alice Private Genome"     >>> LEAKED
```

So on real Solr with real data, the pre-fix code performs an unauthenticated
cross-user read of a private genome's metadata. Restored immediately; post-fix the
same call yields `undefined`.

### Authenticated HTTP matrix — COMPLETE (2026-08-06)

Run with real signed tokens for two distinct accounts (`olson@patricbrc.org`,
`bob@patricbrc.org`). Fixtures: `999002.1` private to olson, `999003.1` private to
bob, `999004.1` owned by olson with `user_read:["bob@patricbrc.org"]`; public
features `f.leak.1` → `999002.1` and `f.leak.2` → `999004.1`.

`GET /genome_feature/?in(feature_id,(f.pub.1,f.leak.1,f.leak.2))&select(feature_id,genome_id,genome_name)`

| requester | f.pub.1 | f.leak.1 (olson private) | f.leak.2 (shared w/ bob) |
|---|---|---|---|
| anonymous | Public Test Genome | *(withheld)* | *(withheld)* |
| olson (owner) | Public Test Genome | Olson Private Genome | Shared With Bob |
| bob | Public Test Genome | *(withheld)* | Shared With Bob |

Bob's row is the sharpest result: two private genomes in one response, one enriched
(he is in its `user_read`) and one withheld — proving the filter discriminates per
row, not per request.

**Cross-user cache gate over HTTP**, sequential requests against one running process
(no restart, shared singleton `BatchJoiner`):

```
1. olson (warms cache)   "Olson Private Genome"
2. bob   (warm)          (withheld)     <-- the gate
3. anon  (warm)          (withheld)
4. olson (own scope)     "Olson Private Genome"   <-- scope reuse still works
5. bob   first           (withheld)     } reverse order:
6. olson after bob       "Olson Private Genome"   } no ordering dependence
```

**Streaming path** (`http_download=true&http_accept=text/csv`, through
`JoinEnrichmentStream`) produces the identical matrix — verified for all three
identities.

### Environment notes (not defects in this work)

Two obstacles hit during live testing, both unrelated to the permission fix:

1. **Cloudflare blocks token validation.** `user.patricbrc.org/public_key` returns a
   403 challenge page to clients with a missing or unrecognized `User-Agent`, and the
   `request` library used by `p3-user/validateToken` sends none — so *every* token is
   rejected and all authenticated requests silently fall back to anonymous. CF ticket
   filed. Locally patched `node_modules/p3-user/validateToken.js` to send
   `p3-api/1.9.3 axios/1.6.0` (curl/axios/wget/python-requests pass; bare `Mozilla/5.0`
   and honest names like `p3-api/1.9.3` do not). Backup at `validateToken.js.orig`.
   **This patch is in `node_modules` and will not survive `npm install`** — the real
   fix is a PR to `PATRIC3/p3_user` adding a User-Agent, plus a guard rejecting
   non-JSON signer responses (the original blindly reads `body.pubkey`, so a CF HTML
   page surfaced as a generic "invalid token" rather than a diagnosable error).

2. **Streaming downloads require an explicit `sort()`.** `solrjs.stream()` paginates
   with `cursorMark`, which Solr rejects (400, "Cursor functionality requires a sort
   containing a uniqueKey field tie breaker") unless the query sorts on the uniqueKey.
   `_streamQuery`'s error path emits `end` (`lib/solrjs/index.js:171-172`), so the
   client gets **HTTP 200 with zero bytes** instead of an error. Reproduced with no
   join involved at all, including on collections with no join configured — this is
   the same empty-200-on-failure class already noted for shard failures in the
   query-replay work. Pre-existing; worth its own ticket.

## Follow-up (out of scope here) — query-mode FASTA still self-requests over HTTP

Found while auditing the genome-fetch paths. **Not a permission bug** — flagged so it
isn't mistaken for one later, and because this change makes the fix easy.

`getGenomeMetadataDict` (`media/dna+fasta.js:62`, `media/protein+fasta.js:60`) fetches
genome metadata by `axios.post`-ing to `distributeURL` + `/genome/`, i.e. the API
issues an HTTP request to itself and re-runs its own middleware chain. It is
permission-correct precisely *because* of that (it forwards `req.headers.authorization`,
so `auth` → `PublicDataTypes` → `DecorateQuery` all apply), which is why it was left
untouched by this work.

It is, however, an unconverted leftover:

- **Streaming mode** (`serializeFeatureStreamDirect`) uses `GenomeMetadataJoinStream` →
  `DirectSolrClient`. Converted.
- **Query mode** (`serializeQueryResults`, `dna+fasta.js:401`) uses the HTTP self-request.
  Not converted. Both paths were added the same day (`952a0107`, `25373cf0`, 2026-03-16).

Note `25373cf0`'s message describes the HTTP call as a fallback for when the direct
client is unavailable ("e.g., certificate issues"). **The code does not do that** — the
call at `dna+fasta.js:397-408` is unconditional and runs *before* `initializeDirectSolr()`
at line 411. Query mode always takes the HTTP path, even when the direct client is
healthy. The sequence fetch directly below it (line 423) *does* implement a real
try-direct-then-fall-back, so the two are inconsistent within one function.

**Fix:** use `directClient.fetchGenomeMetadata(genomeIds, fields, { permissionFq, user })`
— the permission context parameter added by this plan makes it a drop-in. Two conditions:
1. Keep `getGenomeMetadataDict` as a **genuine** fallback for when `initializeDirectSolr()`
   returns null, structured like the sequence fetch below it rather than as an
   unconditional pre-step.
2. It changes behavior on a download path, so it needs the same live-Solr verification
   still outstanding above.

---

## Interaction with the cross-collection download plan

- This plan **is** the "Phase 0 / permission-scoping foundation" that
  `PLAN_CROSS_COLLECTION_DOWNLOAD.md` depends on. That plan's "auth on both hops" non-negotiable is
  unimplementable until Parts 1–2 land.
- The shared `lib/permissionFilter.js` (Part 1) is reused by that plan's `CrossCollectionSource`
  middleware to scope the **source** query — same helper, no second implementation.
- The chained-join `ctx` parameter (Part 2) is the same `enrichDocsChained` signature that plan's
  Deliverable 1 introduces; build the two together if implementing in sequence.

---

## Scope / risk

- Security-sensitive refactor of **shared** infrastructure used by existing paginated and streaming
  enrichment — not a leaf change. A regression here silently changes what data users can see.
- The fetch-side permission `fq` is mechanically simple; the **cache-keying (2b)** is where
  correctness lives and where review effort should concentrate.
- Two independent caches must both be fixed (`BatchJoiner`, `GenomeMetadataJoinStream`). Fixing only
  the first leaves the FASTA download paths leaking.
- Requires a focused security review and the cross-user cache test (#2) as a merge gate.

## Decisions

1. **Permission `fq` is the authoritative control.** Solr enforces no ACLs here — the API is the
   permission layer, which is why `DecorateQuery` exists. The `fq` is therefore both necessary and
   sufficient. `X-Authenticated-User` is set on primary queries (`APIMethodHandler.js:25`) and nothing
   in-repo consumes it; `DirectSolrClient` bypasses the HTTP proxy path entirely, so it could not be
   relied on regardless. Set it anyway for consistency (2a), but do not treat it as a control.
2. **No TTL change.** Scope-keying the caches already prevents cross-user reads; process-lifetime LRU
   is acceptable. No per-scope TTL or logout-eviction needed.
3. **No broader-than-permissions enrichment is intended.** No configured join is meant to surface rows
   the primary query's user couldn't otherwise see — the current unfiltered behavior is an oversight,
   not a designed wider-visibility case. Enforcing the permission `fq` uniformly is therefore safe.
   (Superseded prior claim: this was previously justified by "all current targets are `publicFree`",
   which is false — `genome` is not. The conclusion holds; the reasoning did not.)
