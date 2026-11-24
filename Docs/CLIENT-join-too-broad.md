# Client contract: `join_too_broad`

For the web front end, and any other client that issues a `genome(...)` filter.

## What the API returns

When a `genome(...)` clause matches more genomes than the server will process, the request
is refused **before** it reaches Solr:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```
```json
{
  "status": 400,
  "error": "join_too_broad",
  "message": "This query matches 14,940,584 genomes, which is too many to process (limit 150,000). Please narrow the filter — for example, choose a more specific taxon.",
  "genomeCount": 14940584,
  "limit": 150000,
  "taxonId": "10239"
}
```

| field | | notes |
|---|---|---|
| `error` | `"join_too_broad"` | **branch on this**, never on the prose |
| `message` | English | safe to display verbatim; wording may change |
| `genomeCount` | number | how many genomes the filter matched |
| `limit` | number | the threshold exceeded — **read it, don't hardcode it** (it is server config and is hot-reloaded) |
| `taxonId` | string, **optional** | present only when the filter was purely taxonomic |

`message` is unchanged from before this contract existed, so a client that only prints it
keeps working. Everything else is additive.

**`taxonId` is absent** when the filter was not purely taxonomic — e.g. a
`genome_status:Complete` filter is over the limit but has no taxon to offer children for.
Guard for it.

Rejection is fast: measured **0.53–1.77 s** on alpha, versus the 120 s timeout the same
query produces without this guard.

## Suggested behaviour

The useful move is to turn a dead end into navigation. With `taxonId` you can fetch the
children and let the user drill down:

```
GET /taxonomy/?eq(parent_id,10239)&select(taxon_id,taxon_name,genomes)
    &sort(-genomes)&limit(20)
```

Real output for taxon 10239, so you can see the shape:

```
  2559587      14,985,310  Riboviria
  2731342         275,728  Monodnaviria
  2731341         172,629  Duplodnaviria
  2732004         104,992  Varidnaviria
    12333          36,065  unclassified bacterial viruses
```

**Note the trap in that list.** *Riboviria* holds 14,985,310 genomes — essentially all of
Viruses — so offering it as a one-click drill-down just reproduces the same 400 one level
down, and the user learns nothing. The `genomes` field is right there in the response, so
compare it against `limit` from the error and render accordingly:

- `genomes <= limit` → a normal link; it will work.
- `genomes > limit` → still show it, but mark it as needing further narrowing rather than
  presenting it as a solution.

Taxonomies are lopsided like this routinely; a UI that assumes "the children are smaller"
will frustrate exactly the users who most need help.

So something like:

> **Viruses contains 14.9 million genomes** — more than this view can summarise.
> &nbsp;&nbsp;• *Monodnaviria* (275,728) · *Duplodnaviria* (172,629) · *Varidnaviria* (104,992)
> &nbsp;&nbsp;• *Riboviria* (14,985,310) — still too large, narrow further

Rather than:

> ~~Error: 400 Bad Request~~

Two further refinements worth considering:

- **Scale the wording to the overshoot.** At 1.1× the limit "narrow this slightly" is apt;
  at 100× (Viruses) the honest message is "pick a species."
- **Facet counts are the same query.** A taxon page's facet panel issues the same join, so
  it will 400 too. Render the panel's empty state from this error rather than leaving a
  spinner.

## Do not confuse it with the other two failure modes

Three different things can fail a broad-taxon request, and they want different UI:

| | HTTP | timing | distinguishing field |
|---|---|---|---|
| **too broad** | **400** | **< 2 s** | `error: "join_too_broad"` |
| cold join, under the limit | 500 | ~120 s | message contains `timed out after 120000ms` |
| admission shed | 429 | < 1 s | `Retry-After` header |

- The **500 at 120 s** is a different defect: a cross-collection join over ~1.6 M genomes
  takes **258 s to build cold** and ~70 ms warm, so a cold request cannot finish inside the
  API's 120 s deadline. Full analysis in
  `Docs/BROAD-TAXON-JOIN-COLD-BUILD-2026-10-23.md`. The right UI is "this is taking
  longer than usual" plus a retry — **not** "narrow your filter", because narrowing is not
  what is wrong.
- The **429** is admission control. Honour `Retry-After`; see `Docs/CLIENT-429.md`.

## Bulk downloads need not be refused

A download is not a grid page. The cap protects the single-`{!terms}` rewrite, whose body
grows linearly with the genome count — 14.9 M ids would be a ~190 MB filter. But a
download can resolve the join in **bounded slices**, and the measured cost is roughly flat
in slice size, because the work tracks the total id count rather than how it is cut up
(H5N1, 246,835 genomes, `genome_sequence`):

| batch | body | QTime | batches | total |
|---|---|---|---|---|
| 500 | 5 KB | 25 ms | 494 | 12 s |
| 5,000 | 60 KB | 143 ms | 50 | 7 s |
| 20,000 | 265 KB | 391 ms | 13 | **5 s** |

Projected to Viruses: ~748 batches × ~390 ms ≈ **5 minutes of Solr time**, memory and
request bodies bounded throughout. Slow, but finite — which for a bulk download beats both
the 400 and the 120 s timeout that preceded it.

Enabled by `joinResolution.batchedDownloads` (**off by default** — it turns a fast refusal
into a long response, which is an operational choice). When on:

- `http_download=true` or `call_method=stream` over the limit → **streams**, slowly.
- an ordinary grid page over the limit → still **400**, as documented above.

So a client may see a 400 on the page and a successful download of the same filter. That
is deliberate: a page must be fast or fail fast; a download is already understood to take
a while. If the UI offers "download these results" next to a too-broad grid, the download
is worth offering even when the grid is refused.

Two caveats for the front end:

- **It can take minutes.** Cloudflare cuts a response at ~100 s *of silence*, so the
  serializer must emit bytes early and keep emitting — the existing streaming serializers
  do. Show indeterminate progress, not a spinner with a timeout.
- **No byte count up front.** `numFound` is never computed; the stream just ends.
  `PLAN_DOWNLOAD_SSE_NOTIFICATIONS.md` is the existing plan for completion signals.

## The set of rejected taxa will shrink

Don't hardcode which taxa fail. Today, with `joinResolution` at its default 150,000:

| taxon | genomes | today |
|---|---|---|
| 10239 Viruses | 14,940,584 | 400 |
| 2955291 Influenza A | 1,631,578 | 400 |
| 2 Bacteria | 1,316,755 | 400 |
| 562 *E. coli* | 114,570 | 200 |

When the taxon-subtree rewrite (PR #244, `joinResolution.taxonomicRewrite`) is enabled,
**Influenza A and Bacteria will start succeeding** in roughly 10 s, because that path
resolves them without the join. Viruses still fails — it exceeds both the subtree and
exclusion caps independently, and its 14.9 M genomes are 9× the reject threshold.

So: handle a 400 on *any* taxon, and let the server decide which.

## Testing against it

Alpha has `joinResolution` enabled; production does not yet.

```bash
curl -s 'https://alpha.bv-brc.org/api/genome_sequence/?eq(genome_id,*)&genome(and(eq(taxon_lineage_ids,10239),ne(genome_status,Deprecated)))&limit(1)'
```

To exercise the path against an arbitrary taxon, lower `joinResolution.rejectMaxGenomes`
in a dev `p3api.conf` — it is read per call, so no restart is needed.
