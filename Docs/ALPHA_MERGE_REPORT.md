# Merge report — `feature/distributed-query` → `alpha`

**Prepared:** 2026-08-07
**Branch head:** `0081e498` (pushed to `origin/feature/distributed-query`)
**Target:** `upstream/alpha` (`c1315c2b`)
**Verdict:** **safe to merge** — clean auto-merge, one contested file, no test regressions.

---

## 1. Mergeability

| | |
|---|---|
| Commits on alpha not on branch | 12 |
| Commits on branch not on alpha | 53 |
| Merge conflicts | **none** — `git merge upstream/alpha` auto-merges |
| Contested file | `middleware/APIMethodHandler.js` (auto-resolved, verified by hand) |
| Tests after trial merge | **418 passing, 2 failing** (both pre-existing, see §5) |

> **Diff against `upstream/alpha`, not the merge base.** The merge base (`223a99d3`,
> 2026-06-29) predates alpha's security PRs, so a base-relative diff over-counts the delta
> and shows already-shipped fixes as new.

### Why it merges cleanly despite 12 alpha commits

Nine of alpha's twelve commits are merges or the four security fixes (IDOR #176, JBrowse
SSRF #175/#177, numeric-validation #179, double-encode SSRF #180). **Those four fixes are
already on this branch under different hashes** — they were applied to both lines
independently. Verified byte-identical content:

| branch commit | alpha commit | fix |
|---|---|---|
| `6cc8b390` | `c11a3671` | IDOR: permissions on every doc in multi-ID get |
| `ccd3b92a` | `7024d7a7` | SSRF via JBrowse annotation param |
| `77c00cb9` | `8f0ee573` | 400 on invalid numeric params |
| `5aa6f73a` | `6308e65e` | SSRF via double-encoded `shards` |

`SolrQuerySanitizer.js` and `routes/JBrowse.js` are **byte-identical to alpha**. Only
`APIMethodHandler.js` differs, and only by the branch's join-enrichment hook — alpha's IDOR
check is present and untouched. Both survive the merge; confirmed in a scratch worktree.

---

## 2. What the branch adds

53 commits, +8704/−771 across 61 files. Four themes.

### A. Distributed query subsystem (net-new vs `master`, partially on alpha)

Parallel shard querying with cursor pagination, k-way merge sort, and streaming. Shaken
down by replaying captured real-user traces against a dev server: **five defects found and
fixed** (alias resolution, dropped `q=` constraint, backpressure EOF truncation,
JSON-stream header crash, facet/group misrouting), and the branch validated as
**result-identical to production** across four user workloads. Details:
`Docs/DISTRIBUTED_QUERY_SHAKEDOWN.md`.

Ships `scripts/replay-queries.js`, including a live A/B mode (`--compare`) that sends each
query to both a dev server and production simultaneously — isolating code differences from
data drift.

### B. Permission-scoped join enrichment — **security fix**

Enrichment's secondary Solr fetches carried **no permission filter**. Not latent: `genome`
— the target of every configured join — is not in the `publicFree` allowlist, so private
genome rows were fetched unfiltered and cached user-blind in a process-wide singleton.

**Verified against live Solr: with the fix reverted, an anonymous request enriching a
public feature that references a private genome reads back that genome's name.** Reaching
it requires a public row pointing at a private one — precisely what a cross-collection
download produces.

- `lib/permissionFilter.js` — single source of truth for the permission `fq`;
  `DecorateQuery` now calls it too, so primary and secondary queries cannot drift apart.
- Both enrichment caches are scope-keyed. A fetch-only fix still leaks from a warm cache.
- Merge gate: a cross-user warm-cache test, confirmed to fail against a fetch-only fix.

### C. Cross-collection downloads (new capability)

Download from one collection using another's filter — a Specialty Genes grid downloading
protein FASTA from `genome_feature` — in **one request, with no IDs on the wire**. Replaces
the web client's prefetch round-trip, which shipped ~178 KB of RQL for 3,584 IDs and scaled
linearly toward the 30 MB body cap.

New middleware is **inert unless `http_source_*` params are present**. Source and target
are permission-scoped independently. See §4 for the API contract.

### D. GenBank download performance

Multi-genome GenBank downloads stalled in production. Root cause was a too-low HAProxy
`global maxconn` shedding the API's keepalive sockets, which the API then hung on for ~166 s
with no timeout. Fixed API-side with backpressure, disconnect handling, pipelined fetches,
and a Solr request timeout + retry. Also converted the serializer from HTTP self-calls to
direct Solr queries. Report: `Docs/GENBANK_DOWNLOAD_PERFORMANCE.md`.

---

## 3. Shared-path risk

Most of the branch is additive (new files) or guard-gated. The changes that alter
**pre-existing behavior on shared code paths** are these, and they are where review effort
belongs:

| file | Δ | what changed | risk |
|---|---|---|---|
| `middleware/DistributedQuery.js` | +62 −8 | join-enrichment hook; error forwarding across the pipe boundary | medium — shared streaming path |
| `lib/solrjs/rql.js` | +41 −2 | `terms()` operator; empty-group guard; unknown-operator rejection | medium — touches all RQL |
| `routes/dataType.js` | +38 | two new middleware, `_originalRql` capture | low — additive, ordered |
| `middleware/APIMethodHandler.js` | +23 −1 | join-enrichment hook on `streamQuery` | medium — shared streaming path |
| `middleware/http-params.js` | +13 | capture `http_source_*` | low |
| `middleware/DecorateQuery.js` | +11 −8 | delegates to `permissionFilter` | **low but security-relevant** |
| `lib/solrjs/index.js` | +11 | optional request timeout | low |
| `util/streamWithBackpressure.js` | +6 −2 | EOF-truncation fix | low |
| `media/json.js` | +6 | stream-header crash fix | low |

**Two behavioral changes worth flagging explicitly:**

1. **`DecorateQuery` was refactored** to call `buildPermissionFq`. Output is identical for
   every real user id — verified across 60 collection/user/allowlist combinations. The only
   difference is that Solr metacharacters in a user id are now escaped, which real ids
   (`user@patricbrc.org`) do not contain.
2. **`rql.js` empty-group guard.** `and()`/`or()` used to serialize to a literal `q=()` when
   every child was consumed into `fq`/`fl`/`rows`, which Solr rejects with
   `Cannot parse '()'`. Now yields `q=*:*`. This *fixes* previously-400ing queries such as
   `genome(...)&select(...)&limit(...)`; it cannot break a query that already worked.

---

## 4. New API surface

Additive only. No existing endpoint, parameter, or response shape changes.

### Cross-collection downloads

```
POST /{target_collection}/?http_download=true
     &http_accept={format}
     &http_source_collection={source}      # NEW
     &http_source_link_field={field}       # NEW
Content-Type: application/rqlquery+x-www-form-urlencoded

<the source collection's filter, verbatim>
```

Allowlisted triples (extend via `crossCollectionDownload.allowedSources` in `p3api.conf`,
not code):

| source | link field | target |
|---|---|---|
| `sp_gene` | `feature_id` | `genome_feature` |
| `genome` | `genome_id` | `genome_feature` |
| `genome` | `genome_id` | `genome_sequence` |

An unallowlisted triple returns **400** naming the triple, not a silent empty file. Works
with every serializer (FASTA, GFF, CSV, TSV, JSON) because resolution emits ordinary target
documents.

Response headers `X-Source-Rows` / `X-Resolved` / `X-Result-Count` are set — but **only
land on empty downloads**, because a streaming response commits headers before the counts
are known. That is inherent, not a defect; see §6.

### RQL `terms()` operator

```
terms(genome_id,(83332.12,1000565.3,...))
```

Emits Solr's hash-set `{!terms}` filter instead of the boolean OR tree `in()` produces.
Materially faster for large value lists, and goes into `fq` (filter-cached) rather than `q`.

### Other

- `text/gff3` and `text/x-gff3` accepted as aliases for `application/gff`.
- GenBank downloads must target `/genome/`; other collections return **400** with a pointer
  (previously streamed millions of feature docs to recover a genome-id list).
- Unknown RQL operators return a clear error rather than the opaque
  `undefined field object:<name>` from Solr.

---

## 5. Test status

**418 passing, 2 failing** after the trial merge. Both failures are pre-existing and
unrelated — each reproduces on the branch *and* on alpha before merging:

1. `fastaHeaderFormatter` — "should handle missing values gracefully". Long-standing
   assertion mismatch on header formatting.
2. `SSRF Integration Tests` — "should allow legitimate queries". Requires a live API on
   port 3001; fails as an environment issue, not a code issue.

New coverage added by the branch: 7 new spec files, including an HTTP integration suite for
cross-collection downloads that derives expectations from Solr at runtime and skips cleanly
when the API/collections/tokens are unavailable.

**Verification approach worth noting.** Security-relevant fixes were checked by
deliberately reverting the fix and confirming the tests fail — a test that passes both
before and after proves nothing. This caught one test that was passing vacuously.

---

## 6. Known limitations and open items

Carried into alpha as-is; none block the merge.

| item | status |
|---|---|
| `X-Result-Count` only reaches empty downloads | inherent to streaming; the user-visible path is `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md`, a hard dependency for the download UX |
| Failed streaming download returns 200 + empty body | pre-existing, API-wide; ticketed in `Docs/BUG-stream-failure-returns-empty-200.md` |
| `rql=` form field requires double-encoding | pre-existing; ticketed in `Docs/BUG-rql-form-field-decoding.md`. Website is unaffected (it double-encodes already) — but that coupling means the two must be fixed together |
| FASTA query-mode still self-requests over HTTP | `getGenomeMetadataDict` is permission-correct but unconverted; follow-up noted in the enrichment plan |
| `p3-user` User-Agent patch | lives in `node_modules/`, dies on `npm install`. Cloudflare 403s the token-validation key fetch for UA-less clients, silently degrading every authenticated request to anonymous. CF ticket filed; upstream PR to `PATRIC3/p3_user` still needed |

---

## 7. Recommendation

**Merge.** The delta is large but well-partitioned: one genuine security fix
(permission-scoped enrichment, live-verified as a real anonymous cross-user read), one new
capability that is inert unless explicitly invoked, and a performance subsystem already
validated as result-identical to production against real user traffic.

Concentrate review on the four medium-risk files in §3 — specifically the two
join-enrichment hooks in the shared streaming path, which are `try/catch`-guarded at setup
but whose mid-stream error behavior is newer than the rest.
