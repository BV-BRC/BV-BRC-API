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

## Test to add

`tests/test-api/` — POST the same query through all three entry paths (`rql=`
form field, `rqlquery+x-www-form-urlencoded` body, GET query string) with a
multi-word value, and assert all three return identical results. There is
currently no test covering encoding parity across entry paths, which is why the
divergence persisted.
