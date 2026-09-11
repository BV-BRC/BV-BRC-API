# Open questions and follow-ups

**Created:** 2026-09-11
**Scope:** items left open by the `summary_by_taxon` / wedged-coordinator investigation, plus
other open threads carried in project notes. Not a backlog of everything — just the things that
are known-open and would otherwise be re-derived from scratch.

Items are grouped by whether they are *blocking/breaking*, *security*, or *cleanup*. Within
each group, roughly highest-value first.

---

## Breaking / user-visible

### TODO-1 — Large-taxon crossCollection joins time out (Viruses) or crawl (Bacteria)

**Opened by:** this investigation, 2026-09-11. Full data in
`Docs/GENOME_FEATURE_HANG-2026-09-10.md`.

After the wedged coordinator was fixed, one failure remains and it is **deterministic**, not
load-dependent. Join cost scales with the number of joined genomes:

| taxon | genomes matched | join result |
|---|---|---|
| 1929297 | 7 | 200, QTime 2593 ms |
| 1773 | 46,764 | 200, QTime 4172 ms |
| 562 | 119,464 | 200, QTime 9162 ms |
| 2 (Bacteria) | 1,382,169 | 200, **QTime 73699 ms** |
| 10239 (Viruses) | 15,564,398 | **500, 120 s timeout** |

`summary_by_taxon/10239` is broken; `summary_by_taxon/2` "works" at 74 s, which no page should
wait on. Reproduces 4/4, and 3/3 with the facet removed, so it is the join and not the facet.

**This is not a new problem — it is the known #1 stability risk.** Project notes record the
2026-06-25 OOM crash of three Solr data nodes caused by exactly this: cross-collection joins on
broad taxa (taxon:2, 93M DocSets per shard). `PLAN_SOLR_OVERLOAD_PROTECTION.md` already
specifies the countermeasures under "Eliminating Cross-Collection Joins":

- SQLite cache for `taxon_id → genome_id`, resolving joins locally
- `{!terms f=genome_id}` rewrite for taxa with ≤10–50 K genomes
- **reject** queries for taxa above ~200 K genomes (root-level viral/bacterial)
- `timeAllowed=60000` injection in `Limiter.js` for all queries carrying a join
- block `{!join}` in `SolrQuerySanitizer` for client-submitted Solr queries

**Open question:** that plan document is **not in this worktree** (only
`PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` and `PLAN_GENOME_POSTFILTER.md` are). Locate it before
starting — the design work is likely already done. Verified as *not yet implemented* here:
`grep timeAllowed middleware/Limiter.js` → nothing; `SolrQuerySanitizer` does not block `{!join}`.

Note the genome counts above disagree with the notes' figures (562 = 119 K here vs 156 K
recorded; totals 18.8 M vs ~15.6 M under 10239). Worth reconciling — could be data growth,
could be that one of the two counts is permission- or `public:true`-scoped.

**Cheap partial mitigation, already scoped:** `genome` carries `cds`/`mat_peptide` fields and
`json.facet={CDS:"sum(cds)"}` answers in **0.3 s regardless of taxon size** — but the counts
disagree with the join (562: 637 M vs 1.05 B; 1929297: 22,672 vs 37,105). Resolve the
`genome.cds` discrepancy and the worst cases get a fast path. See TODO-6.

### TODO-2 — Global Search returns zero results (client query-shape bug)

Carried from project notes; **highest priority in that workstream, breaking.** New client
(3.59.1) returns 0 for `protein_structure` where PROD's old client returns 24,684. Reproduces
on alpha and local → **not backend**. `buildGlobalSearchQuery.js` wraps genome-scoped cores in
a `genome(...)` join with recency filter `completion_date:[NOW-1YEARS TO *]`;
protein_structure's genome_ids point at old reference genomes that all fail it → intersection
zero. Fix is client-side: for count-only "Top Matches" (`limit(3)`), skip the recency join.
Report: `../bvbrc_website/query-logs/REPORT-global-search-performance.md`.

Systemic angle worth noting: a recency window that was a grid-read optimization has leaked into
count semantics, so it under-counts *any* core tied to older genomes. Confirm whether
protein_feature's zero is the same false zero.

### TODO-3 — Silent HTTP 200 on mid-stream shard failure

**Already written up: `Docs/BUG-stream-failure-returns-empty-200.md`** (open, not fixed;
reproduced against a live API 2026-08-07). Listed here only so it appears alongside the
others — see that document, not this entry, for detail.

Two independent instances of the same defect are recorded: `lib/solrjs/index.js:170-173` plus
five sibling `stream.emit('end')` sites, and the distributed path in
`middleware/DistributedQuery.js` (~line 248) where `ParallelQueryCoordinator._failAll` emits
stream `'error'` after 200 + `[` has already gone out. Setup-time CLUSTERSTATUS failure falls
back cleanly; only mid-stream leaks.

Worth flagging as a **pattern rather than isolated incidents**: an upstream failure arriving as
a well-formed-looking success. The `summary_by_taxon` TypeError fixed on alpha was the same
class, and so is the 504-reported-as-500 issue this branch addresses.

---

## Security

### TODO-4 — ACL field disclosure (open, unfixed)

`owner` / `user_read` / `user_write` are ordinary indexed fields, readable **and facetable**.
Permission enforcement in this API is **row-level only** — `DecorateQuery` decides which
documents you see, nothing decides which *fields* of a visible document you may read, facet, or
sort on. Because facet counts are computed over the whole permission-filtered DocSet, one
request yields a ranked collaborator graph of email addresses with per-account counts —
directly harvestable for phishing. `eq(user_read,<user>)` is also an account-existence oracle.

Bounded: no private record *content* leaks, and anonymous requests disclose nothing (verified).
Requires an authenticated account.

Write-up `Docs/SECURITY-acl-field-disclosure.md` on branch `security/acl-field-disclosure`
(commit `ad37e541`, pushed, **deliberately no PR** — a security finding may warrant a different
disclosure path).

**Open decision:** cheap fix (block ACL fields as `facet.field`/`sort`/`group.field` targets,
extending the `SolrQuerySanitizer` precedent — kills the part that scales) vs complete fix
(field-level projection filtering, a genuinely new concern for a codebase whose every control
is a row-level `fq`, and which must also cover `fl=` smuggling and the streaming /
cross-collection paths that bypass the middleware chain).

Any regression test must assert **exact counts**, not that the request succeeds — the failure
mode is a 200 carrying too much data.

---

## Correctness / cleanup

### TODO-5 — `/data/*` has no permission filter at all

`/data/taxon_category/` queries `genome` with **no `DecorateQuery` and no `PublicDataTypes`**,
i.e. no permission filter whatsoever. Currently by design — `/data/*` reports public-only
counts — but it is undocumented in the code and load-bearing for the caching decision below.

Related and worth keeping together: `/data`'s `apicache` key is `req.originalUrl` **only**
(`appendKey: []`), so it is **not user-scoped**. Any future change that lets these routes see an
authenticated identity would leak private counts into a cache served to everyone. The
self-call-elimination work already had to defend this invariant explicitly.

### TODO-6 — Reconcile `genome.cds` against joined `genome_feature` counts

`sum(cds)` over `genome` disagrees with the crossCollection CDS count:

| taxon | join count | `sum(cds)` |
|---|---|---|
| 562 | 1,053,060,095 | 637,262,972 |
| 1929297 | 37,105 | 22,672 |

Either `genome.cds` is stale, or the two count different things (annotation source? RefSeq vs
PATRIC? the join's `feature_type:(CDS OR mat_peptide)` vs a single field?). Note the schema also
carries `patric_cds`, `refseq_cds`, `plfam_cds`, `hypothetical_cds`, `partial_cds`, which is
suggestive. **Settling this unblocks a 0.3 s fast path for TODO-1** and would tell us which
number the UI has actually been showing.

### TODO-7 — `&gt` entity-decode corrupts RQL (website side still open)

Intermittent: a website global search builds valid RQL
`keyword(x)&gt(completion_date,NOW-1YEARS)`, and somewhere before the XHR **`&gt` is
HTML-entity-decoded to `>`**, producing a bogus `keywordgt` operator and a Solr 400.
**API-side mitigation shipped** (`lib/solrjs/rql.js` now throws
`Query Syntax Error: unknown operator <name>` instead of emitting `object:<name>`), so a
recurrence is actionable in the log rather than opaque. **Website fix still needed** — entity-
encode the query where it passes through HTML, or keep RQL out of an HTML context.

Exact decode site never localized; ruled out WHATWG/`<a>.href` parse, `/navigate`→`Router.go`,
PathJoin, xhr.get (all preserve `&gt` in Node) — it is browser-DOM-specific and did not
reproduce reliably. To pin it: log `JSON.stringify(this.state.search)` at `GenomeList.js:56`
and reproduce; that distinguishes URL→state corruption from corruption at XHR send.

### TODO-8 — `protein_feature` distributed prewarm regression

`utils.prewarmShards` issues an `await` rows=0 query carrying the **full join `fq`** to every
shard before the real query runs the join again — the join is evaluated twice cluster-wide,
with a barrier. Cost scales with collection_size × shard_count, not result count, so it kills
big cores (protein_feature 29 ms → 15,675 ms; genome_feature 16.8 s; sp_gene 20.5 s) while
helping small ones. Fix: gate or skip prewarm for count/small-limit queries. Also confirm how
`limit(3)` count queries reach the distributed path at all (threshold is rows ≥ 10000).
Explicitly **not** `shards.preference` — the distributed path targets replica URLs directly and
never sees it.

### TODO-9 — Self-call elimination, step 3 onward

`feature/eliminate-self-call` (pushed, based on `6397c6cf`), plan in
`PLAN_ELIMINATE_SELF_CALL.md`. Steps 1–2 shipped. **Step 3 — `/data` characterization tests —
is next and needs a live API + Solr.** Steps 4–6 convert `multiQuery`, `dataRouter`,
`ExpandingQuery`; step 7 adds a wall-clock deadline in `util/http.js`.

Step 7 is directly relevant to this investigation: `util/http.js` has **no timeout mechanism at
all** (absent, not unset), and it carries all 17 self-call sites including the four in
`dataRouter.js`. A socket timeout also does not bound agent *queue* time, so worst case is
(unbounded queue wait) + 120 s. A deadline started at request creation fixes both.

Note `dataRouter.js` was edited today (TODO-1's error handling); expect a small conflict when
step 5 converts it.

---

## Resolved — kept briefly to stop re-investigation

- **Wedged Solr coordinator** causing intermittent 120 s hangs on `genome_feature` and
  `pathway`. Found on-prem 2026-09-11, countermeasures in place, verified: 22/22 uncached
  probes clean. The `replica.base:random` vs PULL/TLOG correlation noted during diagnosis was
  **circumstantial and wrong** — do not treat it as a finding.
- **`summary_by_taxon` TypeError masking upstream errors.** Already fixed on `alpha` by the
  self-call elimination work — `dataRouter` now uses in-process `internalQuery` plus
  `failSubQuery`, and a `.catch()` that also covers a throw from inside a success handler.
  A separate fix developed against `master` was **discarded as redundant**; alpha's version is
  strictly better (it closes the unhandled-rejection hazard, which under
  `--unhandled-rejections=strict` kills the process).
- **Upstream Solr timeouts reported as 500.** Fixed on this branch: `lib/internalQuery.js` now
  classifies a timeout rejection as **504**, and `failSubQuery` gives it a distinct message.
  Verified end-to-end against a black-hole server (connection accepted, never answered).
