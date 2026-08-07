# BUG — `rql=` form-field POSTs require callers to double-encode the query

**Component:** Data API (`p3_api`) — `routes/dataType.js:185-199`
**Severity:** low-moderate. No known broken caller today; it is an undocumented
encoding contract that silently rejects the obvious usage.
**Status:** open, not fixed. Found 2026-08-07 while testing cross-collection
downloads; unrelated to that feature.

---

## Summary

When an RQL query is POSTed as an `rql=` **form field**
(`Content-Type: application/x-www-form-urlencoded`), the API decodes it once
more than the RQL parser expects. Callers must therefore percent-encode the
query **twice** for it to work.

Sending a query that is correctly encoded exactly once — the natural thing to do
— fails with an opaque 400:

```json
{"status":400,"message":"Illegal character in query string encountered  "}
```

Note the message names no field, no position, and the offending character is a
space rendered between two spaces. It reads like a server fault rather than a
caller encoding problem.

## Reproduction

Against any collection; no cross-collection or download params needed.

```bash
# FAILS — query encoded once (the intuitive form)
curl -X POST 'http://localhost:3001/sp_gene/?http_accept=application/json' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary 'rql=eq(property,%22Antibiotic%20Resistance%22)%26limit(3)'
# -> 400 Illegal character in query string encountered

# WORKS — same query encoded twice
curl -X POST 'http://localhost:3001/sp_gene/?http_accept=application/json' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary 'rql=eq(property%2C%2522Antibiotic%2520Resistance%2522)%26limit(3)'

# WORKS — same query, rqlquery content-type (body is the query, not a field)
curl -X POST 'http://localhost:3001/sp_gene/?http_accept=application/json' \
  -H 'Content-Type: application/rqlquery+x-www-form-urlencoded' \
  --data-binary 'eq(property,%22Antibiotic%20Resistance%22)&limit(3)'
```

Only values containing characters that must stay encoded are affected — in
practice **spaces**, i.e. any multi-word filter value. Single-token values
(`eq(property,Transporter)`) work either way, which is why this has gone
unnoticed.

## Mechanism

`routes/dataType.js:189-192`:

```js
var body = typeof req.body === 'string' ? querystring.parse(req.body) : req.body
if (body.rql) {
  req.call_params = [decodeURIComponent(body.rql)]
```

`querystring.parse()` **already percent-decodes** field values. The subsequent
`decodeURIComponent()` strips a second layer. So the body must arrive
double-encoded for the query to reach the RQL parser in the encoded form it
requires.

That the parser requires encoding is not a bug — it is RQL's design. `rql/parser.js:119`
rejects any leftover raw character, and a literal space is one:

```js
if (leftoverCharacters) {
  throw new URIError("Illegal character in query string encountered " + leftoverCharacters)
}
```

Confirmed directly: `eq(property,"Antibiotic Resistance")` (literal space) throws;
`eq(property,%22Antibiotic%20Resistance%22)` parses to `property:"Antibiotic%20Resistance"`.

**Correction to an earlier reading of this bug:** it is *not* that
`decodeURIComponent` double-decodes a correctly-encoded query. `querystring.parse`
performs the only decode that matters, and for singly-encoded input the second
call is a no-op. The defect is one decode too many across the pair, not a double
decode by `decodeURIComponent` alone.

## Why the website is unaffected

`bvbrc_website/public/js/p3/util/DownloadExecutor.js:242-246` sets the field to
`encodeURIComponent(query)` where `query` is *already* RQL-encoded. The browser
then encodes again as form data. Two layers go on, and the API's two decodes take
them off — the round trip cancels exactly:

```
client RQL            eq(property,%22Antibiotic%20Resistance%22)&limit(3)
+ encodeURIComponent  eq(property%2C%2522Antibiotic%2520Resistance%2522)%26limit(3)
API querystring.parse eq(property%2C%2522Antibiotic%2520Resistance%2522)%26limit(3)
API decodeURIComponent eq(property,%22Antibiotic%20Resistance%22)&limit(3)   ← intact
```

So this is a **Data API** bug, not a website bug: the website compensates for it
correctly, if accidentally. Anyone writing a new client against the documented
`rql=` form field will hit it, and the error message gives them nothing to work
with.

## Impact

- Third-party/CLI callers using `rql=` with any multi-word value get a 400 they
  cannot diagnose from the message.
- The website's correctness depends on an undocumented double-encode. If someone
  "cleans up" that apparently redundant `encodeURIComponent`, every multi-word
  filter download breaks — and the failure is a 400 on downloads only, easy to
  attribute to the wrong change.
- Query logs of the form field are double-encoded, which makes replay awkward
  (relevant to the query-replay work).

## Suggested fix

Drop the redundant decode and treat the form field as already decoded by
`querystring.parse` — but note this is a **breaking change for the website**,
which must drop its `encodeURIComponent` in the same release. The two are
coupled; changing either alone breaks multi-word downloads.

Options, roughly in order of preference:

1. **Fix both together.** Remove `decodeURIComponent` at `dataType.js:192`/`:195`
   and the `encodeURIComponent` at `DownloadExecutor.js:245`. Cleanest end state,
   requires a coordinated deploy.
2. **Accept both encodings.** Detect whether the parsed value still looks
   percent-encoded (e.g. contains `%25`) and decode only then. Tolerant of both
   clients, but heuristic — a legitimate literal `%25` in a value would confuse it.
3. **Document and improve the error.** Leave the contract, but say so in
   `API_REFERENCE.md` and make the 400 name the field and the character.
   Cheapest, fixes the diagnosability half.

Regardless of option, the error message should identify the offending character
and mention encoding — `"Illegal character in query string encountered  "` with a
bare space is close to useless.

## Best practice: how to quote and encode RQL values

This bug is one symptom of a broader problem — the correct spelling of a
multi-word filter value is **not discoverable**, and three of the four plausible
spellings fail *silently*. Measured against `sp_gene` where
`property:"Antibiotic Resistance"` matches 100 rows and `property:Transporter`
matches 316:

| RQL written by caller | generated Solr `q` | rows | verdict |
|---|---|---|---|
| `eq(property,%22Antibiotic%20Resistance%22)` | `property:"Antibiotic%20Resistance"` | **100** | correct |
| `eq(property,Antibiotic%20Resistance)` | `property:Antibiotic AND property:Resistance` | 0 | silently wrong |
| `eq(property,%22Antibiotic+Resistance%22)` | `property:"Antibiotic%2BResistance"` | 0 | silently wrong |
| `eq(property,Antibiotic+Resistance)` | `property:Antibiotic%2BResistance` | 0 | silently wrong |
| `eq(property,Transporter)` | `property:Transporter` | 316 | correct (single token) |

Every failing row returns **HTTP 200 with an empty result set**. There is no
error to notice — a download just produces an empty file, and a grid just looks
like it has no matches.

### The rule

> **Percent-encode the value, and wrap it in percent-encoded double quotes:
> `eq(field,%22Multi%20Word%20Value%22)`. Use `%20` for spaces, never `+`.**

Single-token values need neither quotes nor encoding, but quoting them anyway is
harmless (`property:"Transporter"` matches identically) — so **always quote** is a
safe blanket rule and avoids having to reason about whether a value might contain
a space.

### Why each failure happens

- **Unquoted with `%20`.** The RQL parser decodes `%20` to a space and, without
  quotes, treats the result as two terms. `toSolr` renders that as
  `property:Antibiotic AND property:Resistance` — a conjunction of two terms that
  never co-occur in a `string` field. Note this is the *most intuitive* spelling
  and it produces a plausible-looking query that matches nothing.
- **`+` instead of `%20`.** `+` means space only in `application/x-www-form-urlencoded`,
  not in a generic percent-encoded string. The RQL parser treats it as a literal
  `+` and escapes it to `%2B` for Solr, so you search for a value containing a
  literal plus sign.
- **Literal space (no encoding).** Rejected outright by `rql/parser.js:119` with
  the opaque 400 this ticket is about. Ironically the *only* failure mode that
  tells you something is wrong.

### Why the encoding must survive all the way down

The value stays percent-encoded through `toSolr` — the generated query really is
`property:"Antibiotic%20Resistance"`, and querying Solr with that literal string
matches 0. It works because `Solrjs` POSTs the entire query string as an
`application/x-www-form-urlencoded` body (`lib/solrjs/index.js:96-102`), so
**Solr's own form parsing performs the final decode**, turning `%20` into a space
at exactly the right moment.

So the encoding is load-bearing end to end, not a transport detail to be
normalized away early. This is worth stating explicitly because it makes the
`rql=` form-field bug above look like a harmless extra decode when it is not:
anything that decodes too early destroys the distinction between "space inside a
quoted value" and "term separator".

### Guidance for client authors

1. Build values with `encodeURIComponent(value)`, then wrap in `%22...%22`.
   Do **not** hand-roll `+` for spaces.
2. Prefer `Content-Type: application/rqlquery+x-www-form-urlencoded` with the
   query as the raw body. That path has exactly one decode and no double-encoding
   contract — it is the shape this API handles most predictably.
3. If you must use the `rql=` form field, encode the whole query **again** on top
   (`encodeURIComponent(rqlString)`), as the website does. Until the ticket above
   is resolved, that is the required contract.
4. **Sanity-check counts.** Because the failure mode is an empty 200, a client
   that never compares "rows the grid showed" against "rows the download
   produced" cannot detect any of this.

### Suggested API-side improvements

- **Reject rather than mis-parse.** An unquoted multi-token `eq()` value almost
  certainly indicates a caller encoding mistake; generating
  `field:A AND field:B` from it is a guess that is wrong far more often than
  right. A 400 naming the field would be strictly better than 0 rows.
- Document the rule in `API_REFERENCE.md` with the table above. It currently
  states neither the quoting requirement nor the `%20`-not-`+` rule.

## Test to add

`tests/test-api/` — POST the same query through all three entry paths (`rql=`
form field, `rqlquery+x-www-form-urlencoded` body, GET query string) with a
multi-word value, and assert all three return identical results. There is
currently no test covering encoding parity across entry paths, which is why the
divergence persisted.
