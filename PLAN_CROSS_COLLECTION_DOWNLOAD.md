# PLAN — Server-side cross-collection sequence downloads (source-scoped)

**Status:** proposal, for vetting against the website download client
**Owner:** Data API
**Depends on:** `PLAN_ENRICHMENT_PERMISSIONS.md` — **shipped 2026-08-06** (commit `2289d3f1`), but see
the Prerequisite section: it delivered the permission foundation, **not** `enrichDocsChained`.
**Related:** `../bvbrc_website/query-logs/BUG2-cross-collection-download-for-api.md`,
`PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` (**required** for the client to learn the result count — see
Response section), `Docs/JOIN_ENRICHMENT_API.md`, `PLAN_SOLR_OVERLOAD_PROTECTION.md` (join
elimination), `Docs/GENBANK_DOWNLOAD_PERFORMANCE.md` (streaming/backpressure pattern this reuses)

---

## Problem

A cross-collection sequence download (e.g. Specialty Genes grid → protein/DNA FASTA) must fetch
sequences from a **different** collection than the grid's own. Today the web client does this in two
hits:

1. **Prefetch** — query the source collection (`sp_gene`) with the grid filter, `select(link_field)`,
   `limit(2500000)`, collect the `feature_id` values into the browser.
2. **Download** — POST the FASTA request to the target (`genome_feature`) with
   `in(feature_id,(…all resolved ids…))`.

This works but for the **all-rows** scope it is structurally bad:

- Two server round-trips per download (a fat JSON prefetch, then the download).
- The resolved ID list is shipped **through the browser** and back as an inline `in(...)` clause —
  ~178 KB of RQL for 3,584 IDs on 3 genomes, scaling linearly; a large genus can produce a
  multi-MB POST body that risks the 30 MB body cap and is slow.
- Every client must independently know the correct `source-pk → link-field` mapping.
- A zero-match download returns a silent `200` + 0-byte file.

The **selected-rows** scope does not have this problem (the chosen rows are already in the browser
and carry `feature_id`) and is out of scope here — this plan targets the **all-rows / filter-scoped**
case where resolution genuinely belongs server-side.

### Why you can't just retarget the filter

The source filter is a property of `sp_gene`, not `genome_feature`. The populations differ (3 genomes:
3,584 sp_gene hits vs 26,464 genome_feature rows). Running the grid filter directly against
`genome_feature` either references non-existent fields or, if genome-scoped, pulls every feature
instead of the specialty-gene subset. The only faithful link is: resolve which `feature_id`s the
source query selects, then fetch those. That resolution is the join.

---

## What already exists in the API

(The sequence hop is wiring. The front hop's chain driver is not — see the Prerequisite carve-out.)

The `genome_feature` FASTA path is **already a two-hop cross-collection join inside the API**:

```
genome_feature query → docs w/ aa_sequence_md5 → feature_sequence (md5 → residues) → FASTA
```

Implemented by `media/protein+fasta.js` / `media/dna+fasta.js` via `SequenceJoinStream`
(`lib/distributed/SequenceJoinStream.js`), which batches, backpressures, and prefetches.

This plan prepends **one hop** on the front:

```
sp_gene query → feature_id batch → [existing genome_feature → feature_sequence pipeline] → FASTA
```

The front hop reuses the existing enrichment machinery: `BatchJoiner` (`lib/BatchJoiner.js`) +
`DirectSolrClient.fetchByIdsAsDict` (`lib/distributed/DirectSolrClient.js`). Nothing about the
sequence hop changes.

---

## Prerequisite: permission-aware enrichment — SHIPPED, with one carve-out

`PLAN_ENRICHMENT_PERMISSIONS.md` shipped 2026-08-06 (commit `2289d3f1`), verified against live Solr.
**Available now, no work needed here:**

- **`lib/permissionFilter.js`** — `buildPermissionFq({ collection, user, publicFree })`,
  `permissionScopeKey(...)`, and `permissionContext(...)` (returns both, derived from the same inputs).
  Single source of truth for the permission `fq`; `DecorateQuery` calls it too. `CrossCollectionSource`
  reuses it to scope the source query — no second implementation.
- **Identity-threaded enrichment** — `BatchJoiner.enrichDocs(docs, spec, ctx)` and
  `DirectSolrClient.fetchByIds(..., { permissionFq, user })` apply the filter to every secondary fetch.
- **Scope-keyed enrichment cache** — `BatchJoiner`'s LRU is keyed by permission scope, so private rows
  never leak across users. `GenomeMetadataJoinStream` and `SequenceJoinStream` are likewise scoped.

> ### ⚠️ Carve-out: `enrichDocsChained` was NOT built
>
> An earlier draft of this plan asserted the chained joiner "already exists… built together" with
> Phase 0, and treated Deliverable 1 as merely the config/grammar layer on top of it. **That is wrong.**
> Phase 0 shipped `enrichDocs` (single hop) only; `enrichDocsChained` appears nowhere in the codebase.
> The permissions plan mentioned the name in passing as a signature to build *if* the two were
> implemented in sequence — they were not.
>
> **Deliverable 1 therefore includes writing the chain driver itself**, not just the grammar. Scope
> accordingly. `enrichDocsChained(docs, chainedSpec, ctx)` must take the same `ctx = { user, publicFree }`
> as `enrichDocs` and apply `permissionContext({ collection: hop.from, ...ctx })` **per hop** — each hop
> targets a different collection, so each needs its own `fq` and its own cache scope. Threading `ctx`
> only into the first hop leaves the later hops reading unscoped, which is the original bug rebuilt one
> layer down.

Net effect: the "auth on both hops" requirement has a working helper behind it, but the chained joiner
that consumes it is net-new code in this plan.

---

## Design decision: API-side streaming resolution, NOT a Solr `{!join}`

Rejected alternative: post to `/genome_feature/` with
`{!join fromIndex=sp_gene from=feature_id to=feature_id}(<sp_gene filter>)`. One query, but:

- Contradicts the join-elimination direction (`PLAN_SOLR_OVERLOAD_PROTECTION.md`).
- The existing join codegen (`lib/solrjs/rql.js`) is hardwired `fromIndex=genome`; this needs
  net-new join generation anyway.
- Adds new Solr crossCollection join surface (co-location/replica constraints, OOM history).

**Chosen:** the API resolves `source → link` itself, in **bounded batches**, and streams the target
FASTA. Same batched pipeline pattern GenBank already uses (fetch → write → prefetch next). One HTTP
request, zero IDs on the wire, memory bounded regardless of genus size, `{!terms}` instead of `in()`
for the Solr side (the CLAUDE.md-documented efficient path for large value lists).

---

## Two deliverables

This plan delivers the reusable join **and** the download wiring that consumes it. **DECIDED — the
reusable linked join (Deliverable 1) is exposed for JSON/tabular responses too**, not just downloads:
a `select(aa_sequence)` on a `sp_gene` grid read returns the sequence inline via the same chained
join. This falls out of Deliverable 1 automatically — `JoinFieldInjector` and `JoinEnrichment` already
consume the join config for paginated responses; they just need to understand `path` specs (see below).

### Deliverable 1 — Reusable multi-hop join ("linked join")

Today `BatchJoiner.enrichDocs` does a **single** hop (docs → one target collection). Generalize the
join *configuration* to express a **chain** of hops, and add a driver that walks the chain. This makes
`source → link → sequence` a first-class, reusable join usable by JSON/tabular responses and
downloads alike — not just a one-off in the FASTA serializer.

**Config shape (extends `joinEnrichment` in `middleware/JoinEnrichment.js` / `p3api.conf`):**

A joinable field may declare a `path` (ordered list of hops) instead of a single `{from, via, field}`.
Single-hop entries keep working unchanged (back-compat).

```jsonc
{
  "joinEnrichment": {
    "collections": {
      "sp_gene": {
        "joinableFields": {
          // existing single-hop joins unchanged:
          "genome_name": { "from": "genome", "via": "genome_id", "field": "genome_name" },

          // NEW multi-hop: sp_gene.feature_id → genome_feature.aa_sequence_md5
          //                → feature_sequence.md5 → .sequence
          "aa_sequence": {
            "path": [
              { "from": "genome_feature",   "localField": "feature_id",       "foreignField": "feature_id", "carry": "aa_sequence_md5" },
              { "from": "feature_sequence", "localField": "aa_sequence_md5",   "foreignField": "md5",        "field": "sequence" }
            ]
          },
          "na_sequence": {
            "path": [
              { "from": "genome_feature",   "localField": "feature_id",     "foreignField": "feature_id", "carry": "na_sequence_md5" },
              { "from": "feature_sequence", "localField": "na_sequence_md5", "foreignField": "md5",        "field": "sequence" }
            ]
          }
        }
      }
    }
  }
}
```

- Each hop: `foreignField` matched against the incoming `localField`; `carry` names the field pulled
  forward to become the next hop's key; the final hop names the `field` attached to the doc.
- `BatchJoiner` gains an **`enrichDocsChained(docs, chainedSpec, ctx)`** — net-new code, see the
  Prerequisite carve-out — that runs each hop via the existing `_fetchAndCache` (per-collection LRU
  cache, `{!terms}` fetch), feeding hop N's `carry` values as hop N+1's keys. **Per-hop permission
  scoping is mandatory**: compute `permissionContext({ collection: hop.from, user, publicFree })` for
  each hop rather than reusing the first hop's. Hops target different collections with different
  `publicFree` status — e.g. `genome_feature` is permission-filtered while `feature_sequence` is
  exempt — so a single shared `fq`/scope key would be wrong in both directions.
- `stats.missing` already tracks unresolved keys per hop → shortfall is observable for free.
- **Test the chain the way Phase 0 was tested**: assert a non-owner does not receive a chained field
  whose *intermediate* hop row is private, and that the per-hop caches don't serve across users. A
  chain is only as scoped as its weakest hop.

**Security:** the join `path` is **server config only**, never client-supplied. Clients name a
*field* (`aa_sequence`); the API owns the collections/fields the chain touches. This is the same trust
boundary as today's join config.

### Deliverable 2 — Source-scoped download endpoint

New download mode: "stream target FASTA for the records referenced by a **source** query." Reuses the
linked-join resolution for the front hop and the existing `SequenceJoinStream` for the sequence hop,
streamed in batches with backpressure.

New middleware `CrossCollectionSource` in `routes/dataType.js`, placed **after `Limiter`, before
`checkIfStreaming`/`APIMethodHandler`**. When the source headers are present it:

1. Validates `source_collection` + `link_field` against a **server allowlist** (reject arbitrary
   collection/field pairs — same principle as `SolrQuerySanitizer`).
2. Scopes the **source** query with `buildPermissionFq({ collection: sourceCollection, user, publicFree })`
   from the prerequisite `lib/permissionFilter.js` — the source query must be user-scoped, not just the
   target. (The target/sequence hops are scoped by the already-permission-aware enrichment machinery;
   see Prerequisite above.)
3. Stores `req._crossSource = { collection, linkField, query, ctx: { user, publicFree } }` and lets the
   FASTA serializer drive the batched pipeline instead of consuming a single `genome_feature` stream.
   The `ctx` is passed into `enrichDocsChained` so both hops are permission-scoped.

Pipeline:

```
cursor sp_gene(filter, select(feature_id))         ── batch of N feature_ids ──►
  {!terms f=feature_id}<batch> on genome_feature   ──►  SequenceJoinStream (md5→seq)  ──►  write FASTA
  (prefetch next sp_gene batch while writing current)   honor res.write drain; stop on res.destroyed
```

When no source headers are present, behavior is **identical to today** (query runs against the target
directly). Additive, backward compatible.

---

## API description — for vetting against the website client

> This section is the contract. Please check it against `DownloadExecutor.js` before we build.

### Request

The download is POSTed to the **target** (sequence) collection, describing the **source** scope via
`http_*` headers/params. The RQL body is the **source** query, verbatim (the grid filter).

```
POST /genome_feature/?http_download=true
      &http_accept=application/protein+fasta            # or application/dna+fasta
      &http_source_collection=sp_gene                   # NEW — the grid's own collection
      &http_source_link_field=feature_id                # NEW — field on source that links to target
      &http_fasta_id_fields=patric_id
      &http_fasta_description_fields=product
      &http_fasta_id_prefix=
      &http_fasta_context_fields=
Content-Type: application/rqlquery+x-www-form-urlencoded

rql = <the sp_gene grid filter>&sort(+id)             # the SOURCE query — NOT rewritten by the client
```

Notes for the client side:
- **No prefetch, no `in(feature_id,(…))`, no `limit(2500000)` ID list.** The client sends the grid
  filter it already has and nothing else. The API resolves and streams.
- The FASTA header params (`http_fasta_*`) are interpreted against the **target** collection
  (`genome_feature`), exactly as today.
- The `sort` in the body applies to the **source** cursor (stable pagination for resolution); it does
  not need to match any target ordering.
- When `http_source_collection` is **omitted**, the endpoint behaves exactly as it does now (direct
  query against `genome_feature`). Existing same-collection and genome-keyed downloads are unaffected.

### Allowlisted source→target mappings (initial)

Server config. A request whose (`source_collection`, `link_field`, target) triple is not allowlisted
gets a **400** (not a silent empty file).

**Verified 2026-08-06 against `../bvbrc_website/public/js/p3/util/DownloadFormats.js`** — this table is
the `formatOverrides` entries (lines 220-224 for `genome`, 264-265 for `sp_gene`), which are the
authoritative client-side source→target map:

| `http_source_collection` | `http_source_link_field` | target (URL collection) | client format(s)                          | sequence field |
|--------------------------|--------------------------|-------------------------|-------------------------------------------|----------------|
| `sp_gene`                | `feature_id`             | `genome_feature`        | `protein+fasta`, `dna+fasta`              | aa/na via md5  |
| `genome`                 | `genome_id`              | `genome_feature`        | `protein_feature+fasta`, `dna_feature+fasta` | aa/na via md5  |
| `genome`                 | `genome_id`              | `genome_feature`        | **`gff`**                                 | *(not a sequence format — see below)* |
| `genome`                 | `genome_id`              | `genome_sequence`       | `contig_dna+fasta` (sortField `sequence_id`) | contig sequence |

Two corrections against the earlier draft of this table:

- **`genome_feature → genome_feature` removed.** It was listed as "degenerate; direct" but no such
  mapping exists client-side — `genome_feature` has no `formatOverrides` block at all, because a
  `genome_feature` grid downloading sequences is already same-collection and never takes the
  cross-collection path.
- **`gff` added, and it is not FASTA.** `genome → genome_feature` via `gff` is a cross-collection
  redirect that produces GFF, not sequences. **Consequence for Phase 3:** the batched source-resolution
  pipeline cannot be wired only into `media/protein+fasta.js` / `media/dna+fasta.js`. Either wire the
  GFF serializer too, or explicitly scope phase 3 to the FASTA formats and leave `gff` on the existing
  client prefetch path until a later phase — but say which, rather than discovering it during
  implementation.

Note the client's `sp_gene` entry also carries `secondaryDataType: 'genome_feature'` /
`secondaryPK: 'feature_id'` alongside the `formatOverrides`; confirm which of the two the wizard
actually reads when building the spec (`UnifiedDownloadWizard.js:562-634`) before finalizing the
server-side allowlist keys.

(Extend by config, not code, as new grids need it.)

### Response

- **Success:** `application/octet-stream`,
  `Content-Disposition: attachment; filename="BVBRC_genome_feature.fasta"`, FASTA body — byte-identical
  to what the two-hit client path produces today.
- **Observability headers** (set before the body; safe for the client to read):

  | Header             | Meaning                                                              |
  |--------------------|---------------------------------------------------------------------|
  | `X-Source-Rows`    | count of source records the filter matched                          |
  | `X-Resolved`       | count of distinct link values resolved to target records            |
  | `X-Result-Count`   | count of sequences written (`0` ⇒ empty download — client should warn)|

  `X-Source-Rows > X-Resolved` signals source rows with null/unmatched link field (silent drop today).
  This is the shortfall the client cannot self-diagnose; the API can, from `BatchJoiner.stats.missing`.

  > **These headers are not readable by the website client on their own.** Downloads are hidden-form
  > POSTs (`DownloadExecutor.submitDownloadForm`), a browser-native navigation whose status, headers,
  > and body are all invisible to JS. The headers are still worth setting — they serve curl, logs, and
  > any future `fetch`-based client — but **the user-visible path for the count is
  > `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md`**, which carries `X-Result-Count` to the browser over an SSE
  > side channel (see its §"On stream end: PUBLISH … count"). That plan already identifies this
  > header-invisibility as the reason it exists. Treat it as a hard dependency for the
  > empty/partial-download UX below, not an optional companion.

- **Zero matches:** **DECIDED — `200` with an empty body + `X-Result-Count: 0` header, and the event
  is logged.** Wire contract unchanged (won't break clients that tolerate empties). No non-200 for
  empties.

  **Regression watch:** today the client detects emptiness *because* it does the prefetch itself —
  `DownloadExecutor.js:312-315` rejects with "No matching records found" when `linkIds.length === 0`.
  Moving resolution server-side **removes that check**, so if this ships before the SSE channel (or
  some other readable signal), a zero-match download silently hands the user a 0-byte file — exactly
  the BUG2 symptom this plan claims to fix. Sequence the two accordingly, or keep a lightweight
  readable count request until SSE lands (`PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` §"needs none of this"
  describes such an XHR pre-check).

- **Errors:** allowlist miss or bad source query → `400` with a JSON `{status, message}` (same shape as
  the GenBank collection guard), before any body bytes.

### Behavior parity checklist for the client

- [ ] Client stops issuing the prefetch for the all-rows cross-collection case; sends grid filter +
      `http_source_*` instead (`DownloadExecutor.js:284-333` is the block that goes away).
- [ ] Client surfaces empty/partial to the user **via the SSE channel**, not response headers — a
      form-POST download cannot read headers. Removing the prefetch also removes the existing
      `linkIds.length === 0` check (`DownloadExecutor.js:312-315`), so this is a *replacement*, not an
      addition. See `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md`.
- [ ] Selected-rows scope is unchanged (still reads `feature_id` off in-browser rows; may optionally
      migrate to the same endpoint later, out of scope here). Note the client already skips the
      prefetch for `scope === 'selected'` (`DownloadExecutor.js:284`).
- [ ] Same-collection / link==pk downloads unchanged.
- [ ] `gff` (`genome → genome_feature`) either handled server-side or explicitly left on the client
      prefetch path — it is a cross-collection redirect but not a FASTA format.

---

## Middleware placement (`routes/dataType.js`)

```
RQLQueryParser
SolrQuerySanitizer
DecorateQuery
Limiter
CrossCollectionSource        ← NEW: parse+validate http_source_*, permission-scope source query,
                                     set req._crossSource
JoinFieldInjector
DistributedQuery
ShardsPreference
checkIfStreaming
APIMethodHandler             ← when req._crossSource set, source resolution drives the stream instead
ExtractCustomFields
ContentRange
JoinEnrichment
media (protein+fasta / dna+fasta)  ← consumes req._crossSource pipeline
```

---

## Edge cases / non-negotiables

- **Auth on BOTH hops.** Satisfied by the prerequisite work: target/sequence fetches are scoped by the
  permission-aware enrichment machinery (`enrichDocsChained` + `ctx`), and the source cursor query is
  scoped with `buildPermissionFq` in `CrossCollectionSource`. Missing source-side scoping would be an
  IDOR reading another user's private `sp_gene` rows into a download — so the source scoping in phase 1
  is still the highest-risk item to get right, even though the underlying helper already exists.
- **Backpressure + disconnect.** Batched loop honors `res.write` drain and stops on
  `res.destroyed`/`close` (mirror `media/genbank.js`). Do not reintroduce the no-timeout stall class
  (`Docs/GENBANK_DOWNLOAD_PERFORMANCE.md`).
- **Batch size** tuned to the `{!terms}` sweet spot (a few thousand IDs/fq). This is the round-trip vs
  per-query-cost knob. **Configurable:** defaults to `distributedQuery.cursorBatchSize` (currently 2000,
  `lib/distributed/DistributedQueryConfig.js`), with an optional `crossCollectionDownload.batchSize`
  override in `p3api.conf` if the source-cursor batch wants to diverge from the shard cursor batch.
- **Dedup link values** within/across batches before the target fetch (many source rows can share a
  `feature_id`); `{!terms}` + the LRU cache already collapse duplicates, but dedup per batch keeps the
  fq small.
- **`select()` on the source cursor** is forced to the link field only (don't stream full source docs).
- **Source cursor pagination is unblocked.** An earlier risk note claimed `collectionUniqueKeys` was
  empty in config, so `sp_gene` cursors would 400. **Not true** — `config.js:102` populates 36 entries
  including `sp_gene: 'id'`, `genome: 'genome_id'`, `genome_feature: 'feature_id'`,
  `genome_sequence: 'sequence_id'`. `RQLQueryParser` reads it at `middleware/RQLQueryParser.js:6`.
  The source cursor can paginate; no config work needed. Note the cursor sort **must** include the
  uniqueKey (Solr rejects `cursorMark` otherwise — see the empty-200 gotcha in CLAUDE.md); the client
  already does this at `DownloadExecutor.js:100-107` and the server-side cursor must too.

---

## Phasing

**Phase 0 — DONE (prerequisite), except `enrichDocsChained`.** `PLAN_ENRICHMENT_PERMISSIONS.md`
shipped `lib/permissionFilter.js`, identity-threaded `enrichDocs`/`fetchByIds`, and the scope-keyed
enrichment caches (commit `2289d3f1`, live-Solr verified). It did **not** ship `enrichDocsChained` —
that moves into Phase 2 below. See the Prerequisite carve-out.

1. **Contract + guard + allowlist + source permission scoping.** Parse `http_source_*`, validate
   against allowlist, scope the source query with `buildPermissionFq` (from Phase 0), set
   `req._crossSource` (including `ctx`). No streaming behavior yet (falls through to normal path if
   unset). Lands the security boundary first — still the highest-risk item to get right even though the
   helper already exists.
2. **Linked join: chain driver + config grammar.** `enrichDocsChained` does **not** exist — this phase
   builds it *and* the `path` grammar. Budget for both.
   - **2a. Consolidate the join config/spec-builder into one module.** Today `getJoinConfig()` and
     `buildJoinSpecs()`/join-key logic are **duplicated** across `middleware/JoinFieldInjector.js` and
     `middleware/JoinEnrichment.js` (the source comments flag it: "Duplicated to avoid circular
     dependencies"). Extract into a shared `lib/joinConfig.js` (config load + `path`/single-hop spec
     parsing + required-key computation) that both middleware import. **Do this before adding `path`
     support** — otherwise the `path` grammar has to be implemented twice and will drift between the
     injector (builds specs, injects first-hop key into `fl=`) and the enricher (runs them). This is
     load-bearing for decision #2 (JSON/tabular exposure), where BOTH consumers must understand `path`.
   - **2b.** Add `path`-spec parsing to the shared module. Single-hop `{from, via, field}` specs remain
     valid (back-compat).
   - **2c. Build `enrichDocsChained(docs, chainedSpec, ctx)`** — the chain driver itself. Per-hop
     permission scoping (own `fq`, own cache scope, per `hop.from`), plus the cross-user tests
     described in Deliverable 1.
3. **Batched two-hop download pipeline.** Cursor source → `{!terms}` target → `SequenceJoinStream` →
   write, with backpressure + prefetch, passing `req._crossSource.ctx` into `enrichDocsChained`. Wire
   into protein/dna FASTA serializers — **and decide explicitly whether `gff` is in or out of this
   phase** (it is a cross-collection redirect but not a FASTA format; see the allowlist table).
4. **Signals.** `X-Result-Count` / `X-Source-Rows` / `X-Resolved`, empty-result log,
   `DEBUG=p3api-server:media:fasta:xsource` timing.
5. ~~**Generalize.** Additional allowlist/join-path entries as config for other
   cross-collection grids.~~ **CLOSED 2026-08-07 — no work outstanding.**

   Audited every `dataEndpoint` in the client's `DownloadFormats.js` (that field is what
   marks a format as cross-collection). There are eight occurrences, collapsing to **four
   distinct (source, linkField, target) triples** — and the shipped allowlist already
   covers all four:

   | source | linkField | target | client formats | allowlisted |
   |---|---|---|---|---|
   | `sp_gene` | `feature_id` | `genome_feature` | `protein+fasta`, `dna+fasta` (L264-265) | yes |
   | `genome` | `genome_id` | `genome_feature` | `protein_feature+fasta`, `dna_feature+fasta`, `gff` (L221-224) | yes |
   | `genome` | `genome_id` | `genome_sequence` | `contig_dna+fasta` (L220) | yes |
   | `genome` | `genome_id` | `genome_feature` | `feature_bvbrc_id`, `feature_genbank_accession` (L144, L155) | yes — same triple |

   The last row is the only thing this audit turned up that was not already known: two
   accession-list formats declared outside `formatOverrides` (they are top-level format
   definitions with `serverSide: true`). They resolve over a triple that is already
   allowlisted, so they need no config — but they emit **TSV**, a format combination the
   verification never exercised. Worth a smoke test; not a blocker.

   Phase 5 was written as "extend by config as new grids need it", which remains the right
   posture. The honest status is that there is nothing to extend today. Re-run this audit
   (grep `dataEndpoint` in `DownloadFormats.js`) when a new cross-collection grid appears.

---

## Decisions (resolved 2026-08-03)

1. **Empty result** — `200` + `X-Result-Count: 0` header + server log. No non-200 for empties.

   **AMENDED 2026-08-07, after implementation.** The header half of this decision only
   works for the empty case, and cannot be made to work in general. Counts are not known
   until resolution finishes, but a streaming download commits its headers on the first
   `res.write` — long before that. So `X-Source-Rows` / `X-Resolved` / `X-Result-Count`
   land only on responses that produced **no body at all**.

   That is not an implementation shortcut. Making the counts both accurate and present in
   the headers of a streamed response would require resolving the entire source set before
   writing a byte — the unbounded-memory behavior this whole feature exists to avoid. The
   two goals are mutually exclusive.

   What this means in practice:
   - **Empty downloads** (the BUG2 case) *do* get the headers, so the most important case
     is covered by the decision as originally written.
   - **Non-empty downloads** get no readable count. `X-Result-Count` is therefore **not** a
     mechanism the client can rely on for partial/shortfall reporting.
   - The counts are always available server-side via `res.locals.crossSourceStats`, and an
     empty result is logged.

   **`PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` is consequently a hard dependency, not a
   companion** — it is the only user-visible path for the count. This was already true for
   a second, independent reason (a hidden-form POST cannot read response headers under any
   circumstances), so the SSE work is doubly load-bearing. Any parity checklist item that
   says "client reads `X-Result-Count`" should read "client receives the count over SSE".
2. **Expose linked join for JSON/tabular too** — yes. `select(<chained field>)` on a paginated read
   returns the joined field inline via the same `path` spec. Not downloads-only.
3. **Batch size** — 2000 default (from `distributedQuery.cursorBatchSize`); configurable via
   `crossCollectionDownload.batchSize` override.

## Open questions

4. ~~Confirm the allowlist mapping table matches the client's map.~~ **RESOLVED 2026-08-06.** Verified
   against `DownloadFormats.js` `formatOverrides` (the authoritative map — `DownloadExecutor.js` only
   *consumes* `spec.linkField`/`spec.sourceDataType`, which `UnifiedDownloadWizard.js:562-634` populates
   from that table). Table above corrected: `genome_feature → genome_feature` removed (does not exist),
   `gff` added, `genome → genome_sequence` contig case confirmed with `sortField: sequence_id`. One
   residual: confirm whether the wizard reads `sp_gene`'s `formatOverrides` or its
   `secondaryDataType`/`secondaryPK` fields when building the spec.

5. **The source query may ITSELF be a cross-collection join — the resolution must decompose it,
   not forward it raw.** (Verified 2026-08-03 against the live API.) A taxon-view grid's filter is not a
   flat predicate; e.g. the Specialty Genes grid under a taxon sends the *source* (`sp_gene`) query as:

   ```
   genome(and(eq(taxon_lineage_ids,114185),ne(genome_status,Deprecated)))
   ```

   This is a `genome(...)` join **from sp_gene → genome**. Two facts the plan must account for:

   - **Solr rejects a `genome(...)` join as the SOLE top-level clause.** Sent to `/sp_gene/` bare, it
     yields `HTTP 400 "Cannot parse '()'"` — the join codegen (`lib/solrjs/rql.js:99`,
     `{!join method=crossCollection fromIndex=genome …}`) emits an empty main query `q=()`. It only
     parses when a top-level term precedes it (grids prepend `keyword(*)`/`eq(feature_id,*)`; the
     current website download stopgap prepends `eq(<pk>,*)` — see
     `../bvbrc_website/public/js/p3/util/DownloadExecutor.js buildQuery`). So when
     `CrossCollectionSource` runs the source cursor
     (`cursor sp_gene(filter, select(feature_id))`, plan §Deliverable 2), it must ensure the source
     filter is a well-formed Solr query — either inject the match-all guard itself, or (better) resolve
     the inner `genome(...)` predicate to a `genome_id` set first and query the source by
     `in(genome_id, …)`.

   - **This is a join-of-a-join.** The front hop the plan already defines
     (`sp_gene → feature_id → genome_feature → feature_sequence`) now sits *behind* another join
     (`genome → sp_gene`) embedded in the source filter. The linked-join / `BatchJoiner` machinery
     should handle a source query that contains a `genome(...)` (or other collection) join by
     decomposing it (run inner genome subquery → `genome_id`s → filter source), **not** by passing the
     raw join string to Solr — otherwise the server hits the same `Cannot parse '()'` the client just
     worked around. Add a test: source-scoped download whose source query is a bare `genome(...)` join.
