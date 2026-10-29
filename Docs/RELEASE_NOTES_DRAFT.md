# Release notes — draft for the next major Data API update

**Status:** working draft. Accumulate items here as work lands; edit into final copy at
release time.
**Audience:** two, and they need different wording — **API consumers** (CLI, scripts,
`P3DataAPI`, third-party tools) and **website users**. Items below are tagged.

> **How to use this file.** Add an entry when you merge something a user could notice:
> a behaviour change, a new limit, a fixed bug that people worked around, or a
> limitation worth stating before someone discovers it. Keep the measured numbers —
> they are what make a release note credible rather than vague. Delete nothing at
> release time; move it to a "previous releases" section.

---

## Rollup: what this release contains, versus `master`

Measured **2026-10-29**: `upstream/master` `6397c6cf` → `upstream/alpha` `0d286757`,
**114 commits ahead / 0 behind** (a fast-forward), **90 files, +17,325 / −298**,
**38 merged PRs** (#206–#257). Of those additions, **5,501 lines across 28 files are
tests**. Re-measure before publishing:

```bash
git rev-list --left-right --count upstream/master...upstream/alpha
git diff --shortstat upstream/master...upstream/alpha
```

This is a large release and most of it is invisible to users — the headline is that the
API now **protects itself under load** and **fails loudly instead of silently**. Grouped
by what a reader would care about:

### Stability and crash fixes

- **Worker crashes from internal HTTP self-calls eliminated.** The API used to call its
  own listening port at 17 sites — over a 36-hour window that was 33% of all traffic.
  A sub-query error returned a plain-text body, `JSON.parse` threw inside an unhandled
  promise, and the worker hung holding a slot; the *next* request then aborted the
  process. Converted to in-process calls (`multiQuery`, `dataRouter`, `ExpandingQuery`).
  Two separate reproducible worker aborts fixed.
- **Every outbound request now has a wall-clock deadline.** Previously a stalled
  connection could hang ~166 s with no timeout. The deadline is armed at request
  *creation*, so it also bounds time spent queued for a socket — which a socket timeout
  does not.
- **Upstream Solr timeouts are now `504`, not `500`.**

### Protection under load

- **Admission control** with separate pools for heavy downloads and interactive traffic,
  so a burst of downloads sheds with `429` + `Retry-After` instead of starving the
  website. Ships **disabled** (`queryAdmission.enabled`); see `Docs/CLIENT-429.md` for
  the client contract that should land first.
- **Over-broad cross-collection joins are refused with an actionable `400`** carrying a
  machine-readable `join_too_broad` code and the genome count, rather than being sent to
  Solr where they have caused JVM OOM on data nodes. Smaller joins are rewritten to a
  local `{!terms}` filter — 3.2× faster on a measured case.
- **`Retry-After` is readable cross-origin** (added to the CORS expose list). Previously
  browsers stripped it, so cross-origin clients ignored the server's pacing and retried
  faster than asked.
- **`scripts/verify-protections.js`** exercises a deployment and reports which
  protections actually work — written because twice a fully green offline suite covered
  the wrong code path.

### Downloads

- **Broad-taxon bulk downloads complete** (see below).
- **Repeated downloads return the same records** (see below).
- **Cross-collection downloads** resolve a source filter server-side instead of making
  the browser round-trip millions of IDs.
- **GenBank downloads** must target `/genome/`; other collections now get a clear `400`
  pointing there rather than streaming millions of feature docs.

### Correctness fixes that produced plausible-looking wrong output

This class matters most for anyone who downloaded data previously — each returned
HTTP 200 with a well-formed but wrong body:

- **Distributed sorted results were mis-ordered.** The merge comparator used ICU
  collation while Solr sorts by UTF-8 bytes, so correctly-sorted shards were interleaved
  wrongly — 7 out-of-order positions in 25,000 rows on a live query.
- **Large `terms()`/`in()` filters silently returned nothing** past ~148 IDs: shard pages
  were GETs, the shard answered `414`, and the client saw HTTP 200 with a one-byte body.
  Shard pages are POSTs now; verified at 3,000 IDs / 166 KB.
- **Join enrichment could serve one user's private data to another** — a process-wide
  cache keyed without the permission scope. Fixed and verified against live Solr.

### Security

- **Anonymous account enumeration** via `facet.mincount=0` on ACL fields — 30,513 account
  names with no credentials. **Documented, not yet fixed**; decide before release whether
  it ships mitigated or disclosed (`Docs/SECURITY-acl-field-disclosure.md`).
- CORS credentials gated on an origin allowlist; CORS option typos fixed.

### Performance

- **`terms()` filters emit `cache=false`** — measured 3952 ms → 676 ms on a 6,000-ID
  query co-occurring with another clause. The win is `fq`-versus-`q`, not hash-set versus
  boolean.
- **`Limiter` recognizes both `in()` and `terms()` ID lists**, so the two operators get
  identical `rows` and the same transport.

### New operator-facing configuration

All default to the conservative setting; none changes behaviour until switched on:

| key | default | effect |
|---|---|---|
| `queryAdmission.enabled` | `false` | bounded concurrency + queue, `429` on overflow |
| `joinResolution.enabled` | `true` | reject/rewrite over-broad joins |
| `joinResolution.batchedDownloads` | `false` | let a refused join stream in slices |
| `joinResolution.slicedSummary` | `false` | compute `summary_by_taxon` by slicing |
| `joinResolution.taxonomicRewrite` | `false` | taxon-subtree rewrite with deprecated exclusion |
| `streamDribble.enabled` | `false` | hold back a byte reserve to survive proxy silence limits |

**Operational note:** rolling between these two points needs `npm ci`, not just a
checkout — the manifests differ. Then `pm2 reload`.

---

## Known limitations to state explicitly

### Large downloads cannot be resumed

**Audience:** both. **Priority:** high — users hit this unaided and misread it.

> **Interrupted downloads must be restarted, not resumed.** The BV-BRC Data API streams
> query results as they are generated, so a download has no fixed size and no stable
> byte positions. HTTP range requests are not supported. If a browser download is
> interrupted, "Resume" will produce an **empty file** — restart the download instead.
>
> For very large or unattended transfers, prefer the BV-BRC command-line toolkit, which
> handles retries more robustly than a browser can.

**Why this needs to be in the notes rather than left to discover.** The failure is
confusing in a specific way: Chrome offers a Resume button, the user clicks it, and gets
a zero-byte file with no error. That looks like a server bug, and saying so up front
prevents a support ticket and a lost download.

**We cannot suppress the Resume button.** `Accept-Ranges: none` is the standard "do not
attempt ranges" signal and Chrome ignores it for this purpose — measured, a response
with that header and one without behave identically, both offering Resume. The
affordance is Chrome's, driven by its own interrupt reason and the partial file it kept.
Documentation is the only lever we have, which is why this entry matters.

Detail for anyone who asks (full analysis in `PLAN_TWO_PHASE_DOWNLOAD.md` §6a):

- Downloads are chunked with no `Content-Length` and no `Accept-Ranges`, so a browser
  will not resume them. Measured against Chrome 156: **1 attempt** against this shape,
  versus **6 auto-retries to completion** against a properly resumable one.
- On a manual Resume click, Chrome issues **no request at all** — the resume fails
  locally, before anything reaches the API. (An earlier draft of this note said Chrome
  sent a `Range`, got a `200`, and rejected it; that was inferred from a curl probe and
  direct measurement disproved it. The user-visible outcome is the same.)
- This is not a planned fix for browsers. Resumable bulk transfer belongs in the
  toolkit, which has the partial file on disk and can truncate to a record boundary —
  something a browser cannot do.

**Do not "fix" this by adding `Accept-Ranges`.** Measured: a server that advertises the
header but ignores `Range` makes Chrome **retry forever without advancing**. Half
support is worse than none.

---

## Fixes worth calling out

These two are summarized in the rollup above; the detail is kept here because both need
user-facing wording and one needs an advisory for people who downloaded data earlier.

### Broad-taxon bulk downloads now complete

**Audience:** both.

> Downloads covering very large taxa — all Viruses, all Bacteria — previously failed
> after about two minutes with a gateway timeout, or produced a truncated file with no
> error. These now complete.

Fixed in PR #255: the distributed query path discarded the batched-join stream prepared
for over-broad joins and sent an unresolved cross-collection join to every shard.
Verified end to end — a 2,500,000-record protein FASTA download of taxon 10239 completes
through Chrome and Cloudflare; `limit(10000)` on that taxon went from **HTTP 524 after
125 s** to **HTTP 200 in ~5 s**.

### Repeated downloads of the same query now return the same records

**Audience:** API consumers especially — anyone comparing or re-running downloads.

> A download whose filter spanned a very large taxon could return a *different* subset of
> records on each run, with the correct record count and no error. Identical requests now
> return identical results.

Fixed in PR #254: the batched join path did not pass the caller's `sort` to Solr, so each
slice came back in replica-dependent internal order and the row cap selected an arbitrary
subset. Before the fix, three runs of one `limit(5000)` download differed in **~75% of
their records**; after, they are byte-identical.

**Note for anyone who downloaded broad-taxon data before this release:** results were
complete in count but not reproducible. Re-download if exact reproducibility matters.

Ordering caveat worth stating: for these batched downloads, `sort()` orders records
*within* each internal slice, not globally across the whole file. Results are
deterministic and complete; they are not globally sorted. Ordinary (non-batched)
downloads are unaffected.

---

## Items to add before release

Placeholders — fill in from the merge log:

- [ ] Admission control / `429` behaviour, if enabled by release time — cross-reference
      `Docs/CLIENT-429.md`, which is the normative client contract.
- [ ] `Retry-After` now readable cross-origin (PR #240).
- [ ] Join rejection for over-broad queries: the `400` message and `join_too_broad`
      error code — cross-reference `Docs/CLIENT-join-too-broad.md`.
- [ ] Concurrency limits, **if** any are documented for users: alpha runs 3 workers and
      the admission pools are per worker, so published numbers must be slots × workers
      (heavy 9/18, interactive 60/60 on a 3-worker deployment) — not the per-pool
      figures. **Confirm production's worker count separately; do not assume it matches
      alpha.** Tuning is deferred until production runs this, so hold this item until
      the numbers settle rather than publishing figures that will move.
