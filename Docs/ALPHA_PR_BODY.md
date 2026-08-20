# Distributed query, permission-scoped enrichment, and cross-collection downloads

Merges `feature/distributed-query` into `alpha`. `upstream/alpha` has already been merged
into this branch (`8959c330`), so this is a fast-forward with no conflicts to resolve in the
UI.

**68 files, +9544/−775.** Large, but well-partitioned: one security fix, one new capability,
one performance subsystem, and the tests/docs for all three. Most of it is new files or
guard-gated code paths.

Full write-up with evidence: [`Docs/ALPHA_MERGE_REPORT.md`](Docs/ALPHA_MERGE_REPORT.md).

---

## What's in it

### 1. Permission-scoped join enrichment — security fix

Enrichment's secondary Solr fetches carried **no permission filter**. This was not latent:
`genome` — the target of every configured join — is not in the `publicFree` allowlist, so
private genome rows were being fetched unfiltered and cached user-blind in a process-wide
singleton.

**Verified against live Solr: with the fix reverted, an anonymous request enriching a public
feature that references a private genome reads back that genome's name.** Reaching it
requires a public row pointing at a private one, which is exactly what a cross-collection
download produces.

`lib/permissionFilter.js` is now the single source of truth for the permission `fq`;
`DecorateQuery` calls it too, so primary and secondary queries cannot drift apart. Both
enrichment caches are scope-keyed — a fetch-only fix still leaks from a warm cache.

### 2. Cross-collection downloads — new capability

Download from one collection using another's filter (Specialty Genes grid → protein FASTA
from `genome_feature`) in **one request with no IDs on the wire**. Replaces the client
prefetch that shipped ~178 KB of RQL for 3,584 IDs and scaled toward the 30 MB body cap.

```
POST /genome_feature/?http_download=true&http_accept=application/protein+fasta
     &http_source_collection=sp_gene&http_source_link_field=feature_id
body: <the sp_gene grid filter, verbatim>
```

Additive and inert unless `http_source_*` is present. Source and target are permission-scoped
independently. Allowlisted pairs only — an unlisted triple gets a 400 naming it, not a silent
empty file.

### 3. Distributed query subsystem

Parallel shard querying with cursor pagination and streaming. Shaken down by replaying
captured real-user traces against a dev server: **five defects found and fixed**, and the
branch validated as **result-identical to production** across four user workloads. Ships
`scripts/replay-queries.js`, including a live A/B mode that queries dev and prod
simultaneously to separate code differences from data drift.

### 4. GenBank download performance

Production stalls root-caused to a too-low HAProxy `global maxconn` shedding the API's
keepalive sockets, which the API then hung on for ~166 s with no timeout. Fixed API-side
with backpressure, disconnect handling, pipelined fetches, and a Solr request timeout +
retry.

### 5. Outbound User-Agent

No outbound request identified itself, and Cloudflare treats UA-less clients as bots — which
silently broke token validation, degrading every authenticated request to anonymous with no
error. All outbound calls now send `bvbrc-api/<git-describe>`, a shape allowlisted in the CF
rules and verified live.

---

## Review focus

Most of the diff is additive. These files change **pre-existing shared-path behavior** and
are where review effort is best spent:

| file | Δ | change |
|---|---|---|
| `middleware/DistributedQuery.js` | +62 −8 | join-enrichment hook; pipe-boundary error forwarding |
| `lib/solrjs/rql.js` | +41 −2 | `terms()` operator; empty-group guard; unknown-operator rejection |
| `middleware/APIMethodHandler.js` | +23 −1 | join-enrichment hook on `streamQuery` |
| `middleware/DecorateQuery.js` | +11 −8 | delegates to `lib/permissionFilter` |

Two of these deserve a note:

- **`DecorateQuery`** produces byte-identical output for every real user id — checked across
  60 collection/user/allowlist combinations. The only behavioral difference is that Solr
  metacharacters in a user id are now escaped, and real ids don't contain any.
- **The `rql.js` empty-group guard** *fixes* queries that previously returned 400.
  `and()`/`or()` used to serialize to a literal `q=()` when every child was consumed into
  `fq`/`fl`/`rows`; it now yields `q=*:*`. It cannot break a query that already worked.

Note the four security fixes already on alpha (IDOR #176, JBrowse SSRF #175/#177, numeric
validation #179, double-encode SSRF #180) are also on this branch under different hashes,
byte-identical. `SolrQuerySanitizer.js` and `routes/JBrowse.js` are unchanged from alpha.

---

## Testing

**432 passing, 2 failing.** Both failures are pre-existing and reproduce on alpha before
this merge:

1. `fastaHeaderFormatter` — long-standing assertion mismatch.
2. `SSRF Integration Tests / should allow legitimate queries` — needs a live API on port
   3001; environmental.

New coverage: 7 spec files, including an HTTP integration suite for cross-collection
downloads that derives its expectations from Solr at runtime and skips cleanly when the API,
collections, or tokens are unavailable.

**On verification method** — security-relevant fixes were checked by deliberately reverting
the fix and confirming the tests fail. A test that passes both before and after proves
nothing; this caught one that was passing vacuously. Six bugs in this work produced HTTP 200
with plausible-looking but wrong output, and four were invisible to a green unit suite — so
the integration tests assert on exact counts rather than "we got bytes."

---

## Known limitations riding along

None block the merge; all are documented.

- **`X-Result-Count` only lands on empty downloads.** Counts aren't known until resolution
  finishes, and a streaming response has committed headers by then. Inherent, not a
  shortcut — making them accurate *and* header-visible would mean buffering the whole result
  set. `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` is the user-visible path and a hard dependency
  for the download UX.
- **Failed streaming downloads return 200 with an empty body** — pre-existing, API-wide.
  Ticketed: `Docs/BUG-stream-failure-returns-empty-200.md`.
- **`rql=` form field requires double-encoding** — pre-existing. Ticketed:
  `Docs/BUG-rql-form-field-decoding.md`. The website is unaffected because it already
  double-encodes; that coupling means both sides must be fixed together.
- **`p3-user` User-Agent patch is not in this PR.** It lives in `node_modules/` and dies on
  `npm install`. Needs an upstream PR to `PATRIC3/p3_user` adding the UA and a guard
  rejecting non-JSON signer responses.
