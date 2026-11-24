# Amendment to PLAN_SOLR_OVERLOAD_PROTECTION.md — October 2026

**Date:** 2026-10-12
**Amends:** `PLAN_SOLR_OVERLOAD_PROTECTION.md` (written ~2026-06, after the June incidents)
**Measured against:** production (`https://www.bv-brc.org/api-for-website`), 2026-10-12
**Status of the base plan:** partly implemented; one of its key mitigations does not work as
described and must not be relied on.

---

## Why this amendment exists

The base plan was written in June 2026 in the immediate aftermath of two scraping incidents
and an OOM crash. Four months on, three things have changed:

1. **Some of it shipped** — notably the download-amplification work, which was the larger
   half of the June problem. That part can be considered done.
2. **One central assumption turned out to be false.** The plan treats `timeAllowed` as a hard
   cap that prevents a query from holding a DocSet in heap. Measured on the live cluster, it
   does not cap anything of the sort. Shipping it as specified would create a false sense of
   protection and, worse, would silently return wrong counts.
3. **The data grew.** The plan's threshold arithmetic is based on genome counts that are now
   substantially out of date — Bacteria is 2.8× the plan's figure, and the whole corpus has
   roughly doubled. A threshold chosen against June numbers is the wrong threshold today.

Separately, the intermittent failures that dominated September — the wedged Solr coordinator
— have been fixed on-prem. That matters here because it removed the noise that was masking
the join problem. What is left is deterministic and measurable, which is what made the
numbers below possible.

This document records current state, corrects the plan where measurement contradicts it, and
proposes a revised sequence. It does not replace the base plan; the architecture, the attack
analysis, and the Layer 1–4 framing all still stand.

---

## Background: what the two problems actually are

It is worth separating them, because the plan treats them together and they have diverged.

### Problem A — download amplification (the June scraping incidents)

A single genome FASTA download triggers roughly **370 secondary `feature_sequence` queries**
inside the media serializer. During the June 2 attack this produced 15,000+ secondary queries
in 30 minutes, saturating the shard hosts. The damage was not the genome queries themselves —
`genome` is a single-shard collection and handles them easily — it was the fan-out underneath.

The aggravating factor was that `media/genbank.js` had **no concurrency control at all**: five
bare axios call sites going through the full API round trip (`axios → distributeURL → API →
HAProxy → Solr coordinator → shards`), with unlimited default socket behavior.

**This is the part that is now largely fixed.** See "Current state" below.

### Problem B — broad-taxon cross-collection joins (the June 25 OOM crash)

Three Solr data nodes crashed simultaneously with JVM heap OOM. Cause: queries of the form

```
{!join method=crossCollection fromIndex=genome from=genome_id to=genome_id}taxon_lineage_ids:2
```

`taxon_lineage_ids:2` is *all Bacteria*. The join materializes every matching genome into a
DocSet, per shard — 57–93M documents — and holds it for the life of the query, measured at up
to 330 seconds. Several concurrent sessions multiply that heap pressure until a node dies.

The crucial detail, which makes this fixable: **the join is generated entirely by the API. It
never comes from client input.** There are exactly two generation sites, both still present:

| site | what generates it |
|---|---|
| `lib/solrjs/rql.js:99` | the RQL `genome()` clause, for any non-`genome` target collection |
| `routes/dataRouter.js:107` | the hardcoded `summary_by_taxon` feature-count query |

Because we generate it, we can decline to generate it. That is the whole shape of the fix.

**This is the part that is not fixed**, and it is the reason this amendment exists.

---

## Current state, verified 2026-10-12

Checked against `upstream/alpha` (`de7873e9`).

### Shipped

| item | plan ref | evidence |
|---|---|---|
| GenBank ported off uncontrolled axios | Layer 2b | `media/genbank.js` uses `lib/solrjs` with `maxSockets: 8` |
| Serializer concurrency control | Layer 2 | `maxSockets: 10` in `dna+fasta.js:147`, `protein+fasta.js:143`; `batchSize`/`prefetchBatches` via `SequenceJoinStream` |
| GenBank resilience | — | per-request Solr timeout + retry + keepalive toggle; backpressure honored; client-disconnect hang fixed |
| Outbound wall-clock deadline | — | `util/http.js` (`3fc64ead`), covering all 17 self-call sites |
| Genome self-join elimination | "trivially" §576 | `rql.js:95-100` inlines the filter as `&fq=` when target is `genome` — removes ~36% of all joins |
| `terms()` emits `cache=false` | — | PR #207 |
| Replica load balancing | §489 | `shards.preference` moved `replica.type:NRT` → `replica.base:random` |

Note the GenBank port deliberately used `Solrjs` rather than `DirectSolrClient`, contrary to
the plan's Phase 1 wording. That was the right call and is documented in CLAUDE.md: GenBank's
secondary fetches are small single-genome queries that gain nothing from parallel shard
fan-out, and `DirectSolrClient` needs direct network access to every replica — which an
off-site dev laptop lacks, making such a path untestable where it is written. (Corrected
2026-10-27: production itself DOES have that access.)

### Not shipped

| item | plan ref | verified absent |
|---|---|---|
| `timeAllowed` injection in `Limiter.js` | §622 | `grep -c timeAllowed middleware/Limiter.js` → 0 |
| Block `{!join}` in `SolrQuerySanitizer` | §625 | no `join` reference in the file |
| `GenomeTaxonCache` (SQLite) | §630 | `lib/` has no such file |
| `better-sqlite3` dependency | §655 | absent from `package.json` |
| Layer 1 admission control / 429 | §44 | no `429` anywhere in `middleware/`, `app.js`, `routes/` |
| Layer 3 per-host admission | §144 | `maxParallelism` exists in `DistributedQueryConfig`/`DistributedQueryManager`/`ParallelQueryCoordinator`, but that is a parallelism cap, **not** per-host admission |
| Layer 4 Solr circuit breakers | §210 | cluster-side config; not verifiable from the repo |

`ReqCounter` is sometimes mistaken for admission control. It is not — it increments counters
for periodic logging and admits everything.

---

## Correction 1: `timeAllowed` does not do what the plan says

This is the most important change in this amendment.

The plan states (§622):

> **`timeAllowed`**: Inject `&timeAllowed=60000` (60 seconds) into all queries that contain
> cross-collection joins […] This caps how long any query can hold a DocSet in heap. Even if
> a broad query somehow reaches Solr, it can't hold a DocSet alive for 330 seconds.

Measured on the production cluster, 2026-10-12:

| query | `timeAllowed` | wall | result |
|---|---|---|---|
| Bacteria join (taxon 2) | none | 81.2 s | 200 |
| Bacteria join (taxon 2) | 10000 | **64.9 s** | 200, `partialResults: true` |
| Viruses join (taxon 10239) | 10000 | **120 s** | **500 — client timeout**, 2/2 reproducible |
| control: `product:*kinase*`, no join | 2000 | **6.4 s** | 200, `partialResults: true` |

Read the control row first: a plain non-join query given a 2-second budget ran for 6.4
seconds — a 3× overshoot with no join involved at all.

**Mechanism.** `timeAllowed` is checked between *collection* steps — as Lucene iterates
matching documents. It cannot interrupt the construction of the join's DocSet, which is a
single uninterruptible phase, and that phase is precisely what consumes the heap. For Viruses
the query never reaches a checkpoint at all, so the parameter has no effect whatsoever and
the request dies on the client-side 120 s timeout instead.

**Consequences for the plan:**

1. `timeAllowed` **would not have prevented the June 25 OOM.** It must not be recorded as
   mitigating crash risk. It is a weak backstop against slow *iteration*, nothing more.
2. The proposed value of **60000 is useless in practice** — it sits above the 120 s client
   deadline for exactly the queries that need bounding, so the client gives up first and the
   query keeps running server-side, still holding its DocSet.
3. **`partialResults: true` means silently wrong answers.** The Bacteria query returned
   `numFound: 3,260,130,049` from a truncated join. Nothing in the API surfaces that flag, so
   a facet count built on it renders as authoritative. This is the same silent-wrong-data
   class as the empty-200-on-stream-failure defect
   (`Docs/BUG-stream-failure-returns-empty-200.md`). **Shipping `timeAllowed` broadly without
   handling `partialResults` would create new instances of a bug class we are already trying
   to eliminate.**

**Revised recommendation.** Keep `timeAllowed` but demote it: it is a cheap backstop, not a
mitigation, and it is only safe once `partialResults` is detected and surfaced as an error
rather than swallowed. It is no longer a Phase 1 item on its own merits.

---

## Correction 2: the threshold arithmetic is out of date

The plan reasons about a 10,000-genome threshold using these figures: "Bacteria: ~500K,
Proteobacteria: ~200K", "18.8M total genomes, 16.3M are viruses", "E. coli (taxon:562) has
156K genomes".

Measured 2026-10-12:

| taxon | plan's figure | **measured today** |
|---|---|---|
| 2 — Bacteria | ~500,000 | **1,382,167** (2.8×) |
| 1224 — Proteobacteria | ~200,000 | **542,314** (2.7×) |
| 562 — *E. coli* | 156,000 | **119,464** (0.77×) |
| 10239 — Viruses | ~16.3M (as "most of 18.8M") | **15,625,500** |

Note 562 moved *down*. The earlier figure was probably not permission-scoped, or counted a
different alias; either way the lesson is that these numbers need re-measuring at
implementation time rather than being carried forward from a document.

---

## New measurement: join cost scales with genome count, and it is smooth

The base plan has no cost curve — it reasons from the crash and from DocSet sizes. Having one
changes what threshold is defensible. All measurements `genome_feature`, `rows=0`,
`fq=feature_type:(CDS OR mat_peptide)` plus the join, Solr-reported `QTime`:

| taxon | genomes | QTime | outcome |
|---|---|---|---|
| 1929297 | 7 | 2,593 ms | fine |
| 1386 | 14,317 | 2,447 ms | fine |
| 286 | 29,012 | 5,031 ms | fine |
| 573 | 42,829 | 5,866 ms | fine |
| 1773 | 46,764 | 5,777 ms | fine |
| 562 | 119,464 | 11,893 ms | slow |
| 976 | 127,776 | 11,415 ms | slow |
| 1239 — Firmicutes | 326,888 | 29,269 ms | bad |
| 1224 — Proteobacteria | 542,314 | 46,327 ms | bad |
| 2 — Bacteria | 1,382,167 | 73,699–80,947 ms | unusable |
| 10239 — Viruses | 15,625,500 | — | **500, 120 s timeout** |

Two things worth drawing out:

- **There is a floor of ~2.5 s.** Taxon 1929297 has *seven* genomes and still costs 2.6 s.
  Roughly 5.5 s is the floor for any `genome_feature` query at all (8B+ documents); the join
  itself adds only ~200 ms at small sizes. So the join is not inherently expensive — it
  becomes expensive in proportion to the genome set it must materialize.
- **The curve is smooth and roughly linear in genome count**, with no cliff. That is
  important for threshold choice: there is no natural breakpoint in the data, so the
  threshold is a policy decision about acceptable latency, not a discovered constant.

`genome_amr` — which the plan identifies as the *highest-volume* join target (12,008 of
24,599 joins, dominated by taxon 562) — costs **5,007 ms** for taxon 562. Lower than
`genome_feature` for the same taxon, but it is the most frequently executed join in the
system, so it deserves equal weight in any threshold decision.

---

## New measurement: the `{!terms}` rewrite works, and the win is large

The plan proposes replacing the join with a local lookup plus a `{!terms f=genome_id}` filter,
but contains no measurement of that rewrite. It now has one.

**Exact-equivalence test**, taxon 1386 (14,317 genomes), all ids:

| approach | QTime | `numFound` |
|---|---|---|
| `{!join method=crossCollection …}taxon_lineage_ids:1386` | 2,447 ms | 129,545,777 |
| `{!terms f=genome_id cache=false}` + all 14,317 ids | **769 ms** | **129,545,777** |

**Identical result counts**, and **3.2× faster** — while carrying a 144 KB request body. A
5,000-id subset ran in 386 ms, i.e. **6× faster** than the join.

Supporting costs, both cheap:

- Fetching the full 14,317-id list from `genome`: **0.54 s** (`rows=20000&fl=genome_id`)
- Fetching 5,000 ids: **0.30 s**

So even a naive implementation that re-queries `genome` on every request — no SQLite cache at
all — would beat the join at this size. **That is a significant simplification opportunity:**
the SQLite cache is an optimization on top of a rewrite that already wins without it. It can
be deferred, which removes `better-sqlite3`, the startup build, and the
rebuild-after-indexing machinery from the critical path.

Caveat worth stating: 144 KB request bodies interact with the 8 KB shard-fetch ceiling
documented in CLAUDE.md ("Shard pages are POSTs"). The POST fix is already in place and
measured to 166 KB, so this is fine *today*, but anything that reverts shard pages to GET
would break this rewrite too.

---

## Revised assessment: what actually protects the cluster

Putting the corrections together, the two items previously described as the "cheap wins" do
not carry the weight assigned to them:

- **`timeAllowed`** — does not bound the dangerous phase (Correction 1). Weak backstop only,
  and unsafe without `partialResults` handling.
- **Blocking `{!join}` in `SolrQuerySanitizer`** — worth doing, but it is **defense in depth
  only**. The plan itself says no joins are generated from client input, and that is still
  true. It protects against a future client-submitted join; it does nothing about the joins
  we generate ourselves, which are the ones that crashed the cluster.

What actually bounds the damage is the thing the plan treats as the expensive part:
**refusing to issue over-broad joins in the first place.** And the measurements above show
that is cheaper to build than the plan assumed, because:

- a plain `genome` count is ~0.3 s and trivially cacheable — no SQLite needed for the
  *reject* decision;
- the `{!terms}` rewrite needs only an id list, and fetching that is ~0.5 s — no SQLite
  needed for the *rewrite* either, at least initially.

---

## Revised implementation sequence

Replaces "Eliminating Cross-Collection Joins → Code changes" (§628) and reorders Phase 1.

### Step 1 — Reject over-broad taxa at the two join sites (the actual OOM fix)

Before emitting a join, resolve how many genomes the filter matches. Above a threshold,
return **400** with an actionable message ("taxonomy filter too broad — please select a more
specific taxon"). Below it, proceed.

- Sites: `lib/solrjs/rql.js:99` and `routes/dataRouter.js:107`.
- The count is a `rows=0` query against `genome` — ~0.3 s, and cacheable per taxon with a
  long TTL since it moves only with indexing.
- **Threshold: start at 150,000 genomes**, which from the curve above corresponds to roughly
  12–15 s. That admits *E. coli* (119K) and the other common working taxa, and rejects
  Firmicutes, Proteobacteria, Bacteria, and Viruses. The plan's 10,000 is far too aggressive
  against current data — it would reject taxa that today complete in 2.5 s.
- Make it configurable (`p3api.conf`), not a literal. The data grows; see Correction 2.
- **Open question — not mine to decide:** rejecting Bacteria and Viruses is a visible product
  change. Those taxon pages presently either take 74 s or fail outright, so nobody is getting
  a good experience, but "fails fast with an explanation" is still different from "eventually
  loads". Worth a product call before shipping, and it argues for doing Step 2 first where
  the two overlap.

### Step 2 — Rewrite mid-size joins as `{!terms}` (the performance fix)

For taxa under the reject threshold, replace the join with a local id lookup plus
`{!terms f=genome_id cache=false}`. Measured 3–6× faster with identical results.

- **Do this without SQLite initially.** Fetch ids from `genome` directly (~0.5 s at 14K ids)
  and cache the id list per taxon in-process. Revisit `better-sqlite3` only if profiling
  shows the lookup is actually hot — the plan's own rationale for SQLite (sub-ms lookups,
  no GC pressure) is about an optimization, not about correctness.
- `cache=false` is required, not optional — see the `terms()` analysis in CLAUDE.md. A cached
  terms filter makes Solr materialize the DocSet up front and drive iteration from the scored
  query, which measured *worse* than the boolean form (3,952 ms vs 2,418 ms); uncached it was
  676 ms.
- Keep an upper bound on id-list size regardless; a 150K-id body is ~1.5 MB and should route
  to the reject path, not be attempted.

### Step 3 — Block `{!join}` in `SolrQuerySanitizer` (defense in depth)

As the plan specifies, with one implementation note it does not mention: the sanitizer
currently blocks by **parameter name**, and `{!join}` is a *value* inside `fq`. The existing
`findDangerousParamsInString` + `fullyDecode` machinery is the right place, but this needs a
value-level check, not a new entry in `DANGEROUS_PARAMS`. It must also not reject the API's
own generated joins — check ordering against `DecorateQuery` and `rql.js`, which inject at
different stages.

### Step 4 — `timeAllowed`, demoted, with `partialResults` handling

Only after Steps 1–2. Inject a value **well below** the 120 s client deadline (15–30 s, not
60 s), and **detect `responseHeader.partialResults` and surface it as an error** rather than
returning a truncated count as if it were complete. Without that second half this step makes
things worse, not better.

### Step 5 onward — unchanged from the base plan

Layer 1 admission control (429) and Layer 3 per-host admission remain as written. They are
larger pieces of work requiring coordinated client updates, and Steps 1–2 remove the specific
crash risk without them.

### Long-term, unchanged and still the real answer

Add `taxon_lineage_ids` to the `genome_feature` schema and the join disappears entirely —
`fq=taxon_lineage_ids:X` works directly. Requires a full reindex. Everything above is a
bridge to this.

---

## Deployment context

Relevant because none of this protects production until it ships there:

- Production is at **`7f94fc8b`** (2026-08-17), **183 commits behind master**.
- `master` (`6397c6cf`) is **32 behind alpha, 0 ahead** — the lines have converged, so an
  alpha→master merge is clean.
- Production therefore has **none** of the Problem A work listed under "Shipped", and does
  not even have the Solr request timeout from PR #203. Its hang behavior is the old unbounded
  kind, not the 120 s failures measured in this document.
- Rolling the deployment needs **`npm ci`**, not just a checkout — the manifests differ.

---

## Reproducing these measurements

```bash
# genome count for a taxon
curl -s -X POST 'https://www.bv-brc.org/api-for-website/genome/' \
  -H 'Content-Type: application/solrquery+x-www-form-urlencoded' \
  -H 'Accept: application/solr+json' \
  --data-binary 'q=*:*&fq=taxon_lineage_ids:562&rows=0'

# the join, as the API generates it
curl -s -X POST 'https://www.bv-brc.org/api-for-website/genome_feature/' \
  -H 'Content-Type: application/solrquery+x-www-form-urlencoded' \
  -H 'Accept: application/solr+json' \
  --data-binary 'q=*:*&fq=feature_type:(CDS OR mat_peptide)&fq={!join method=crossCollection fromIndex=genome from=genome_id to=genome_id v=taxon_lineage_ids:562}&rows=0'

# the {!terms} rewrite: fetch ids, then filter
curl -s -X POST '.../genome/' --data-binary 'q=*:*&fq=taxon_lineage_ids:1386&rows=20000&fl=genome_id'
# then POST  q=*:*&fq=feature_type:(...)&fq={!terms f=genome_id cache=false}<ids>&rows=0
```

Use `Accept: application/solr+json` to see `responseHeader.QTime` and `partialResults`; the
default JSON view strips them. Compare `QTime` rather than wall time where possible — wall
time includes the HAProxy and coordinator hops.
