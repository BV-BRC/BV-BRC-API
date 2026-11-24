# Release notes — `alpha` → `master`

**Range:** `master 6397c6cf` → `alpha 2d535a5a`
**Measured:** 2026-10-30 · **130 commits**, 0 behind (fast-forward) · **96 files**,
+19,057 / −301 · **44 merged PRs** (#206–#263) · work spanning 2026-08-24 → 2026-10-29

Re-measure before publishing — these numbers move:

```bash
git rev-list --left-right --count upstream/master...upstream/alpha
git diff --shortstat upstream/master...upstream/alpha
```

Of the lines added, **6,147 across 31 files are tests**. That ratio is the honest summary
of this release: most of it is hardening, and most of the hardening is pinned by a
regression test that fails against the old code.

> **Scope note.** This document covers the whole `master`→`alpha` delta and is the
> publication candidate. `Docs/RELEASE_NOTES_DRAFT.md` is the older working scratchpad
> that accumulated items as they landed; it is superseded by this file.

---

## 1. Headline

Two sentences for a release announcement:

> The API now **protects itself under load** and **fails loudly instead of silently**.
> Downloads that previously timed out, truncated, or returned different data on each run
> now complete correctly.

Everything below is detail.

---

## 2. What users will notice

### Bulk downloads of broad taxa now work

Downloads covering very large taxa — all Viruses, all Bacteria, Coronaviridae — used to
fail after about two minutes with a gateway timeout, or produce a truncated file with no
error at all. They now complete.

A 2,500,000-record protein FASTA download of taxon 10239 was verified end to end through
a browser and Cloudflare. The same query at `limit(10000)` went from **HTTP 524 after
125 s** to **HTTP 200 in ~5 s**.

### Repeated downloads return the same records

A download whose filter spanned a very large taxon could return a *different* subset of
records on each run — correct record count, no error, different rows. Three runs of one
`limit(5000)` download differed in **~75% of their records**. Identical requests now
return identical results.

**If you downloaded broad-taxon data before this release:** the files were complete in
count but not reproducible. Re-download if exact reproducibility matters.

One limitation worth stating: on this path `sort()` orders records *within* each internal
slice, not globally across the whole file. Results are deterministic and complete; they
are not globally sorted. Ordinary (non-batched) downloads are unaffected.

### Very broad queries are now refused quickly instead of failing slowly

A query whose genome set is too large to process returns **HTTP 400** in about a second,
with a message naming the count and a machine-readable `join_too_broad` code, rather than
consuming cluster resources and timing out. Client guidance: `Docs/CLIENT-join-too-broad.md`.

### Interrupted downloads must be restarted, not resumed

**This is a limitation, not a change** — it is stated because the failure is confusing.

> The API streams query results as they are generated, so a download has no fixed size
> and no stable byte positions. HTTP range requests are not supported. If a browser
> download is interrupted, **"Resume" produces an empty file** — restart it instead.
>
> For very large or unattended transfers, prefer the BV-BRC command-line toolkit, which
> handles retries more robustly than a browser can.

Chrome offers a Resume button, the user clicks it, and gets a zero-byte file with no
error — which reads as a server bug and is not one. We cannot suppress the button:
`Accept-Ranges: none` is the standard "do not try" signal and Chrome ignores it for this
purpose (measured). Background: `PLAN_TWO_PHASE_DOWNLOAD.md` §6a.

### GenBank downloads must target `/genome/`

Requesting GenBank from a feature-level collection now returns a clear **400** pointing at
`/genome/`, instead of streaming millions of feature documents to recover a genome id
list. Update any saved links.

### Under heavy load, some requests may be shed with `429`

Admission control is implemented but **ships disabled**. When enabled, a burst of
concurrent downloads is shed with `429` and a `Retry-After` header rather than being
allowed to starve interactive traffic. Heavy downloads and interactive queries use
separate pools, so a user browsing the site is unaffected by someone else's downloads.

Clients must honour `Retry-After` — the contract is `Docs/CLIENT-429.md`, and implementing
it in clients is what unblocks enabling this in production.

---

## 3. Correctness fixes — previously plausible-looking wrong output

**This is the section that matters most for anyone who already downloaded data.** Each of
these returned HTTP 200 with a well-formed but *wrong* body, so nothing flagged them.

| defect | symptom |
|---|---|
| Batched-join downloads ignored `sort` | identical requests returned ~75% different records |
| Merge comparator used ICU collation, not Solr's UTF-8 byte order | sorted distributed results interleaved wrongly — 7 out-of-order positions in 25,000 rows |
| Shard pages were GETs | a filter over ~148+ ids hit the shard's 8 KB header limit; client saw HTTP 200 with a one-byte body |
| Join enrichment cache was not permission-scoped | one user's private genome data served to another from a warm cache |
| `multiQuery` stored sub-query failures as results | an inner 500's error text was parsed into the caller's result slot inside an outer 200 |

The enrichment leak was a **live cross-user read**, not a latent one, and is the single
most important item in this table for anyone assessing disclosure obligations.

---

## 4. Stability

### Worker crashes from internal HTTP self-calls — eliminated

The API called its own listening port at 17 sites. Over a 36-hour production window that
was **33% of all traffic** (33,101 requests, 615,681 s cumulative).

Beyond the waste, it was crashing workers. An inner error returned plain text, `JSON.parse`
threw inside an unhandled promise, `--unhandled-rejections=strict` turned that into an
`uncaughtException` which `app.js` swallowed, the request hung holding a worker slot, and
the *next* Solr-backed request aborted the process on a corrupted `async_hooks` state.
Reproduced 3/3 from two unauthenticated GETs.

Converted to in-process calls: `multiQuery`, `dataRouter`, `ExpandingQuery`. Two separate
reproducible worker aborts fixed. **Ten RPC sites remain deferred** — their identity model
is client-supplied and converting them is a design change, not a transport change.

### Every outbound request now has a deadline

A stalled connection previously hung ~166 s with no timeout — long enough for Cloudflare's
~100 s limit to fire first, so users saw a 524 while the worker still held a socket.

The deadline is armed at request *creation*, not on the socket, so it also bounds time
spent **queued** for a socket — which a socket timeout does not. `HTTP_REQUEST_TIMEOUT_MS`,
default 120000.

### Other

- Upstream Solr timeouts now return **504**, not 500.
- Solr `429` responses are handled as back-pressure rather than retried as transport errors.
- A `--stack-size` of 65536 exceeded the OS thread stack, so V8's guard never fired and
  deep recursion segfaulted the worker instead of throwing `RangeError`. Now 7000.

---

## 5. Security

### Fixed

**Anonymous account enumeration via ACL faceting.** Permission enforcement is row-level
only, and facet counts are computed over the whole permission-filtered DocSet — so a facet
over `user_read` returned a ranked list of account names. Measured with **no credentials**:
100 names by default, **30,513** with `facet.limit=-1`.

Now rejected with 400 when `owner`/`user_read`/`user_write` appear as the value of
`facet.field`, `facet.pivot`, `facet.range`, `facet.interval`, `group.field`, `sort`, or
`stats.field`. Verified live, including the raw Solr-format path that bypasses the RQL
parser.

> **Decision needed before publication:** whether to describe this finding in public notes
> at all. It is fixed on alpha but **not on master until this merge ships**, so publishing
> the detail before the deployment is live would disclose a working attack against
> production.

**Also fixed:** CORS credentials gated on an origin allowlist (anonymous cross-origin reads
stay open — this is a public API); CORS option typos; `Retry-After` added to the exposed
headers so cross-origin clients can read the server's pacing.

### Still open, deliberately

- **Per-record ACL visibility** — on a record shared with you, its full ACL is readable,
  and `eq(user_read,<user>)` works as an account-existence oracle. Closing this requires
  field-level projection filtering, a new concern for this codebase. What shipped removed
  the part that *scales*.
- **`rpc/proteinFamily.js`'s `pfs_` cache is not user-scoped** — documented, not fixed; it
  sits behind the RPC identity model. See CLAUDE.md.

---

## 6. Performance

- **Cross-collection joins are resolved locally** where the genome set is small enough,
  rewriting to a `{!terms}` filter: **769 ms vs 2,447 ms** on a measured 14,317-genome
  taxon, identical results.
- **`terms()` filters emit `cache=false`** — **3,952 ms → 676 ms** on a 6,000-id query that
  co-occurs with another clause. The win is `fq`-versus-`q`, not hash-set-versus-boolean.
- **`Limiter` recognises both `in()` and `terms()` id lists**, so the two operators get the
  same `rows` and the same transport. Previously `terms()` was silently routed differently.
- **Summary endpoints are computed by slicing** when a join is refused, and are
  cache-warmed nightly. Taxon 11118 (9.5M genomes) previously could not be computed at all
  — it returned 524 on both alpha and production.

---

## 7. For operators

### Deployment

**Rolling between these two points requires `npm ci`, not just a checkout** — the manifests
differ. Verify before restarting:

```bash
npm ci
node -e "require('dojo-declare/declare'); require('./lib/solrjs'); console.log('deps OK')"
```

Then `pm2 reload`. (`pm2 delete` is not required to pick up new code.)

After deploying, run `node scripts/verify-protections.js <base-url>` — it exercises the
query path and reports which protections are actually working. It exists because **twice,
a fully green offline suite covered the wrong code path and the bug only appeared against
a deployed server.**

### New configuration

All default to the conservative setting. **Nothing below changes behaviour until switched
on**, except `joinResolution`, which is on by default.

| key | default | effect |
|---|---|---|
| `joinResolution.enabled` | `true` | reject/rewrite over-broad cross-collection joins |
| `joinResolution.batchedDownloads` | `false` | let a refused join stream in bounded slices |
| `joinResolution.slicedSummary` | `false` | compute `summary_by_taxon` by slicing |
| `joinResolution.taxonomicRewrite` | `false` | taxon-subtree rewrite with deprecated-genome exclusion |
| `queryAdmission.enabled` | `false` | bounded concurrency + queue; `429` on overflow |
| `streamDribble.enabled` | `false` | hold back a byte reserve to survive proxy silence limits |
| `admin.enabled` | `false` | local-only operational endpoints (loopback + token) |
| `cors_origins` | `[]` | origins allowed **credentialed** cross-origin requests |

### Cache warming

`scripts/warm-taxon-summaries.sh` keeps the broad-taxon summaries warm. It requires
`admin.enabled` plus a token in `p3api.conf`, and **must run against `127.0.0.1`** — the
admin gate refuses the host's own public address, and more importantly four of the six
largest taxa take longer than Cloudflare's ~125 s budget, so these fills are impossible
through the public URL at any speed.

Measured complete run: **53 min for six taxa, 0 failures** (Viruses 22.9 min). Cron at
01:30; the cached TTL is **26 hours against a 24-hour schedule** so a late run cannot race
its own expiry.

### Pool sizing is per worker

Alpha runs **3 workers** and the admission pools are per process, so cluster-facing limits
are slots × workers. `/stats` reports **one worker's** view, not the deployment's. Confirm
production's worker count separately; do not assume it matches.

**Tuning is deliberately deferred until production runs this** — alpha's lighter load is
the wrong baseline.

---

## 8. Known issues carried forward

- `tests/test-util/test.fastaHeaderFormatter.spec.js` — one pre-existing failure, unrelated
  to this work.
- `npm audit` reports advisories whose only remedy is retiring `request-promise`
  (deprecated upstream, no fix available). Scope is 5 files, one of them production;
  tracked in CLAUDE.md, deliberately not bundled here.
- 10 RPC self-call sites remain, including one with a confirmed live worker abort
  (`rpc/transcriptomicsGene.js:141`). Deferred behind the RPC identity model.

---

## 9. Checklist before publishing

- [ ] Re-measure the counts in the header — they move with every merge.
- [ ] **Decide the ACL disclosure question** (§5). It is fixed on alpha but live on master
      until this ships.
- [ ] Confirm production's worker count if any concurrency figures are published (§7).
- [ ] Decide whether §4 and §6 belong in user-facing notes at all, or only in an
      operator/changelog edition — most users need §2, §3 and the resume limitation.
