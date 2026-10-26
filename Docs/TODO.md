# Open questions and follow-ups

**Created:** 2026-09-11
**Scope:** items left open by the `summary_by_taxon` / wedged-coordinator investigation, plus
other open threads carried in project notes. Not a backlog of everything — just the things that
are known-open and would otherwise be re-derived from scratch.

Items are grouped by whether they are *blocking/breaking*, *security*, or *cleanup*. Within
each group, roughly highest-value first.

> **Sequencing for the download-performance / Solr-overload workstream lives in
> `Docs/COMPLETION_PLAN-2026-10.md`.** That roadmap phases TODO-1, TODO-8 and TODO-11
> together with the unstarted admission-control layers and the production deployment. This
> file remains the inventory; that one is the order of work.

---

## Breaking / user-visible

### TODO-13 — Broad-taxon join cold build is 258 s; every deadline in the stack is shorter

**Root cause found 2026-10-23.** Full write-up:
`Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md`.

A `{!join method=crossCollection fromIndex=genome}` over Influenza A (taxon 2955291,
1,625,381 genomes) takes **257,898 ms to build cold** and **70–83 ms warm** — ~3,700×.
The API cuts at 120 s and Cloudflare at ~100 s, so **a cold request can never succeed
through the website.** Verified direct to Solr with no deadline: `HTTP 200` in 257.9 s,
`numFound 1,741,906`.

Not an incident. No OOM, no GC, no commits, no recovery, no contention, no LRU pressure —
all tested and ruled out (§5 of the write-up lists them, plus the measurement traps that
produced false conclusions, so nobody repeats the work).

Three things follow:

- **The 150,000-genome reject threshold in `lib/joinResolver.js` is calibrated against the
  wrong variable.** The predictor of disaster is cache-miss, not genome count: a *warm*
  1.6M-genome join is 70 ms. Rank is also no guide — Influenza A and SARS-CoV-2 are both
  species and both larger than all of Bacteria.
- **The fix is the `{!terms f=taxon_id cache=false}` rewrite** — 3.6 s for the full
  112,721-taxon subtree, no cache dependency, and verified to match the join **exactly**
  (1,949,521 genomes both ways, 0.000% difference). **No longer blocked on
  denormalisation** — see §4.1a: subtract the *deprecated* genome ids as a negative
  `{!terms}`. Deprecated genomes are rare, so that list is 5–400× smaller than the live
  one (4.0 MB vs 20.2 MB here). Verified exact on *E. coli* — 21,789,712 both ways,
  **1,770 ms against the join's 25,097 ms** — and on Influenza A, where the join cannot
  complete at all, cross-checked arithmetically to the document.
- **A `newSearcher` warming query** for taxa 2 / 10239 / 2697049 / 2955291 would stop any
  user paying the cold build. Config-only, complementary, and also covers `sp_gene`,
  `genome_amr` and `genome_feature`, which join too.

**Open sub-question:** what ends a warm period is still unexplained. During a 118-second
window containing two 120 s timeouts, `genome_sequence`'s filterCache showed **0 evictions,
0 searcher resets, size 12/512, 98.5% hit**. Neither LRU nor reopen was evicting it.

**Collateral, worth acting on independently:** `genome_feature`'s filterCache is badly
undersized — **151 of 184 cores pinned at `size=512`, 626,842,974 cumulative evictions,
107.8 GB resident**. Compare `genome_sequence` at max size 12. Different regimes, same
hardware.

### TODO-1 — Large-taxon crossCollection joins time out (Viruses) or crawl (Bacteria) — **RESOLVED 2026-10-15**

> **Fixed by PR #230.** `lib/joinResolver.js` counts a join's genome set before the query
> runs: ≤50,000 genomes is rewritten to a local `{!terms f=<field> cache=false}` filter,
> >150,000 is refused with a 400, and the band between is left alone. Verified against
> live Solr — taxon 1386's 14,317 genomes returned **identical `numFound` (129,545,777) in
> 6,047 ms against the join's 37,163 ms**, a 6.15× speedup. Bacteria and Viruses now fail
> in under a second with an actionable message instead of burning 120 s.
>
> Two corrections to the analysis below, both found during implementation: the join filter
> is an **arbitrary genome query**, not a taxon (so `genome_status:Complete`, 10.3M genomes,
> was also already timing out and is now covered), and the two generation sites spell the
> join differently (`rql.js` trailing, `dataRouter.js` using `v=`) — matching only the
> first would have left `summary_by_taxon` unprotected.
>
> Original analysis retained below for the measurements.

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
broad taxa (taxon:2, 93M DocSets per shard).

**SCOPED 2026-10-12 — see `Docs/OVERLOAD_PROTECTION_AMENDMENT-2026-10.md`.** The plan document
(`PLAN_SOLR_OVERLOAD_PROTECTION.md`) was located; it is on `alpha`, it was simply missing from
the worktree this entry was written in. Its countermeasures were re-measured against the live
cluster and **two of them do not hold up**:

- **`timeAllowed` does not cap DocSet lifetime.** A 10 s budget ran 64.9 s on taxon 2 and had
  no effect at all on taxon 10239; even a plain non-join query with a 2 s budget ran 6.4 s. It
  also returns `partialResults: true` — silently truncated counts that nothing in the API
  surfaces. It would not have prevented the June OOM.
- **The 10,000-genome threshold is far too aggressive** against current data. Taxon 1386
  (14,317 genomes) joins in 2.4 s and rewrites to `{!terms}` in 769 ms.

What does work, measured: the **`{!terms}` rewrite is 3–6× faster than the join with identical
`numFound`** (taxon 1386, all 14,317 ids: 769 ms vs 2,447 ms, both 129,545,777), and the id
list can be fetched straight from `genome` in ~0.5 s — so **the SQLite cache is not required to
start**. Revised sequence in the amendment: reject over-broad taxa first (that is the actual
OOM fix), then the `{!terms}` rewrite, then `{!join}` blocking as defense-in-depth, then
`timeAllowed` demoted to a backstop with `partialResults` handling.

Genome counts, re-measured 2026-10-12 (the discrepancy noted below is data growth, mostly):
Bacteria **1,382,167** (plan said ~500K), Proteobacteria **542,314** (~200K), Viruses
**15,625,500**, *E. coli* **119,464** (the 156K figure was high). Re-measure again at
implementation time rather than carrying these forward.

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

Two independent instances of the same defect were recorded. **One of them is now fixed —
corrected 2026-10-12:**

- **`lib/solrjs/index.js:170-173`** plus five sibling `stream.emit('end')` sites — **still
  open.** This is what `Docs/BUG-stream-failure-returns-empty-200.md` is about.
- ~~the distributed path in `middleware/DistributedQuery.js`~~ — **fixed.** `:266` now
  forwards `'error'` from the source stream to the wrapped stream
  (`wrappedStream.destroy(err)`), with a comment naming this exact failure mode: "a
  coordinator/shard error (or a mid-stream cancel) becomes an unhandled 'error' event ->
  uncaughtException, while the wrapped stream stalls and the response truncates to a silent,
  empty `[`". There is a matching guard on the join-enrichment path at `:386`. Setup-time
  CLUSTERSTATUS failure already fell back cleanly.

So the remaining work is the solrjs streaming path, not the distributed one.

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

### TODO-8 — Shard prewarm is ungated (was: "`protein_feature` distributed prewarm regression")

**Rescoped 2026-10-12 after measurement. The original framing blamed prewarm for the
`protein_feature` slowness; that attribution is wrong, though the prewarm issue itself is
real.**

**What is real.** `utils.prewarmShards` issues an `await`ed `rows=0` query carrying the full
query — join `fq` included — to **every** shard before the real query runs it again. The join
is therefore evaluated twice cluster-wide, with a barrier between. It is gated only by a
global boolean (`DistributedQueryManager.js:157` checks `config.prewarmShards`, default
true), never by query cost, so every distributed query on an 80-shard collection pays it.
Cost scales with collection_size × shard_count, not result count. Fix: gate or skip prewarm
for count/small-limit queries, or make the threshold cost-aware.

**What is not.** The original entry cited `protein_feature` 29 ms → 15,675 ms as evidence.
Measured against both deployments, `eq(genome_id,83332.12)&limit(25000)`:

| | wall | bytes |
|---|---|---|
| alpha (distributed path active) | 40.3 s | 18,268,666 |
| **prod (distributed `enabled: false`)** | **41.8 s** | 18,268,666 |

Near-identical, byte-identical output. `protein_feature` is simply slow at that size on
**both** paths, so this is not a distributed regression. A repeat against alpha returned in
3.6 s — the original 29 ms / 15,675 ms comparison was very likely warm-vs-cold cache rather
than standard-vs-distributed. Treat `protein_feature` large-limit latency as its own
question.

**Resolved sub-question.** The entry asked how `limit(3)` count queries reach the distributed
path at all. They do not: measured on alpha, `keyword(Escherichia)&limit(3)` against
`protein_feature` returns in 0.39 s with **no** `x-distributed-query` header.
`minLimitThreshold` (10000) excludes them, as designed.

Still correct, and worth keeping: this is explicitly **not** `shards.preference` — the
distributed path targets replica URLs directly and never sees it.

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

### TODO-10 — Four streaming serializers still ignore `res.write` backpressure

**Opened 2026-10-12.** `Docs/MEDIA_HANDLER_BACKPRESSURE_PLAN.md` is **implemented** — every
step shipped, including the optional NDJSON one, plus `dna+fasta.js`, `protein+fasta.js`, and
`lib/CrossCollectionSourceStream.js`, which the plan never scoped. `genbank.js` solves it
separately with its own `writeChunk()` awaiting `drain`.

Four streaming serializers were never in that plan's scope and still have the problem it
describes — they call `res.write()` in a stream callback and discard the return value, so the
source keeps being pulled while the socket buffer grows:

| serializer | content type | pattern |
|---|---|---|
| `media/cufflinks+gff.js` | `application/cufflinks+gff` | **`EventStream.mapSync`** — the exact anti-pattern the plan names as "Current Pattern (BAD)", and the last `mapSync` in the tree outside the utility's own fallback |
| `media/sralign+dna+fasta.js` | `application/sralign+dna+fasta` | `EventStream.map`, return value ignored |
| `media/dna+jsonh+fasta.js` | `application/dna+jsonh+fasta` | `transforms.map`, return value ignored |
| `media/protein+jsonh+fasta.js` | `application/protein+jsonh+fasta` | `transforms.map`, return value ignored |

All four are registered content types with live `results.stream` branches, so they are
genuinely reachable. Exposure is lower than for the converted handlers — these are niche
formats and the `jsonh` variants are legacy — but a large download through any of them has
the original unbounded-memory behavior on a slow client.

**Fix:** mechanical. `util/streamWithBackpressure.js` already exists and the four handlers
converted under the plan's Step 2 are the template.

**Verification is the real work, not the edit.** The failure mode here is a well-formed,
successful-looking download with truncated or wrong content — not an error — so this needs a
live API and assertions on **exact row counts**, never on "we got bytes." That is the same
trap documented for cross-collection downloads in CLAUDE.md, where four of six bugs were
only findable over real HTTP. Worth capturing the plan's unmeasured success criteria
(`test-media` passing, bounded memory, disconnect cleanup) as a baseline on the
already-converted handlers *before* touching these four, so there is something to compare
against.

### TODO-11 — A Solr 429 is retried as if it were a transport error — **RESOLVED 2026-10-15**

> **Fixed by PR #226.** `lib/solrHttpError.js` preserves the status code and parsed
> `Retry-After`; `ShardCursorStream` paces a 429 on the server's `Retry-After` against a
> separate `maxOverloadRetries` budget (default 1) so a shedding node cannot also exhaust
> the connection-failure retries, and no longer retries non-429 4xx at all. **This
> unblocks Layer 4** — Solr's circuit breakers and rate limiter are now safe to enable.
>
> Worth keeping: the first version patched `subQuery()` but not `query()`, which is what
> the main data path actually uses. All unit tests passed while a real 429 still reached
> the client as 500. Only an end-to-end run against a 429 stub caught it.
>
> Original analysis retained below.

**Opened 2026-10-12.** Full context: `Docs/ADMISSION_CONTROL_STATUS-2026-10.md`.

`ShardCursorStream._request` rejects on **every** non-2xx response
(`lib/distributed/ShardCursorStream.js:250`), and `_requestWithRetry` (`:171-186`) retries
*any* rejection with exponential backoff up to `maxRetries` (default 3). Nothing inspects
the status code. `DirectSolrClient` has the same shape.

So a Solr node answering **429 — "I am overloaded, back off"** receives up to four requests
instead of one, per shard, from every worker. The response that exists to shed load instead
amplifies it.

**This blocks Layer 4 of `PLAN_SOLR_OVERLOAD_PROTECTION.md`.** Both Solr-side protections
(circuit breakers, rate limiter) signal via 429, so **enabling them against the current API
would make overload worse, not better.** There is no `429` handling anywhere in the tree —
grep returns nothing in `lib/solrjs/`, `lib/distributed/`, or `middleware/`.

**Fix:** make the retry status-aware — treat 429 as "back off, honour `Retry-After`", not as
a generic retriable error, and do not count it against the same retry budget as a connection
failure. Small change, and a prerequisite for the cluster-side work.

### TODO-12 — The 9000-row store cap can be lifted, but doing so makes those requests shed candidates

**Opened 2026-10-16.** A cross-system interaction that is invisible from either side alone,
recorded for whoever lifts the cap.

**The cap exists for a bug that is fixed.** JIRA-4420 — the API returning HTTP 200 with a
one-byte body `[` at `rows >= 10000`, which then fails JSON parsing — was the 8 KB
shard-fetch ceiling. An RQL `in()`/`terms()` clause over a few hundred ids crossed Jetty's
default `requestHeaderSize` of 8192 bytes, the shard answered `414 URI Too Long`, and
`media/json.js` had already written the opening bracket so the status could not change.
Callers worked around it by capping result stores to `Math.min(ids.length, 9000)`.

`ShardCursorStream` now sends each cursor page as a **POST with a form-encoded body**, so
the filter never touches the header limit. Verified against live alpha 2026-10-16 with the
exact failing shape — 3,000 feature ids, a **153 KB** filter body (~20× the old ceiling),
`limit(25000)`:

```
in()     200, 2,546,003 bytes, 3000 docs, parsed OK
terms()  200, 2,546,003 bytes, 3000 docs, parsed OK
```

Gate: `tests/test-distributed/test.shardcursor-post.spec.js` (9 tests; all 9 fail against
the pre-change module).

**Two things to do when raising the cap above 10,000:**

1. **Those requests become heavy-classified and therefore shed candidates.** `rows >= 10000`
   is the admission threshold (`middleware/QueryClassifier.js`), so a store that was
   incidentally kept under it by the 9000 cap will start seeing 429s once admission is
   enabled. They need `retryRequest` coverage per `Docs/CLIENT-429.md` — and for a pipeline
   store that means **unattended mode (§3a)**, a delay ceiling with no attempt cap, not the
   3-retry interactive policy. A pipeline stage that gives up after three 429s loses work.

2. **They will then reach the distributed path for real**, which is where the 8 KB ceiling
   lived. Accompany the change with an actual large-filter integration test, not just the
   unit gate.

**Why this needs flagging rather than discovering:** `Limiter.detectFixedIdCount` caps a
fixed-id query's `rows` to `idCount + 10`, which drops it back below `minLimitThreshold`
(10000). That now covers `terms()` as well as `in()`, so **nothing in normal use reaches the
8 KB code path with a large filter any more** — confirmed in the verification above, where
neither request engaged the distributed path. The regression is currently unreachable
through ordinary traffic, which means a future change re-enabling the GET path would pass
every functional test and break only under a specific combination. CLAUDE.md says as much:
*"do not delete it on the grounds that the bug is unreachable."*

**Also note the truncation bug is a 200, so retry logic must not treat it as retriable** —
it is not a transient condition, and a client retrying it would loop. That remains true for
the still-open mid-stream truncation case (TODO-3).

---

## Deployment posture — context for everything above

Measured 2026-10-12. Worth knowing before interpreting any latency figure in this file,
because "which path did that query take" is not guessable from the outside.

**Distributed query is live on alpha, off in production.** Probed directly:

```
alpha  POST /api/genome_feature/  eq(genome_id,83332.12)&limit(25000)
       -> x-distributed-query: true, x-stream-type: parallel,
          x-parallelism: 8, x-shard-count: 80
prod   same query -> no distributed headers (standard path)
```

Production sets `distributedQuery.enabled: false` deliberately — the path needs direct
network access to every Solr replica, which the production deployment does not have. **Keep
it that way**; the `excludeNodes` list lives only in the untracked `p3api.conf`. Note the
default is `enabled: true` with `enabledCollections: []`, and an *empty* `enabledCollections`
means "no allowlist", i.e. all collections — so a fresh deployment that forgets the flag
turns it on everywhere.

**Correctness of the distributed path is holding.** alpha (distributed) vs prod (standard),
`eq(genome_id,83332.12)&sort(+feature_id)&limit(25000)` — the case that exercises
`MergeSortStream` and the UTF-8 comparator — returned **byte-identical** 9,276,047-byte
responses (1.54 s vs 1.76 s).

**Production is 183 commits behind master**, and master is 34 behind alpha. So production has
neither the distributed subsystem running nor most of the download-amplification work, and
its hang behavior predates even the PR #203 Solr request timeout. Any symptom reported from
production should be checked against its actual SHA before being matched to findings here.
Rolling it forward needs `npm ci`, not just a checkout.

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
