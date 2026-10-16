# Client specification: handling `429 Too Many Requests` from the BV-BRC Data API

**Date:** 2026-10-16
**Status:** normative for all API clients — CLI tools, the website, `P3DataAPI`, scripts
**Supersedes:** the "429 System-Wide Requirements" table in
`PLAN_SOLR_OVERLOAD_PROTECTION.md`, which sketched this for internal components only

---

## Why this matters more than a normal error contract

A 429 means the server is shedding load. **A client that retries it badly makes the
condition it is reacting to worse** — and does so precisely when the system has least
capacity to absorb it. Retry amplification of exactly this kind was identified as the cause
of the 2026-06-05 coordinator crash: users and tooling re-issuing requests against a
cluster that was already saturated.

So the rule that matters is not "retry on 429." It is **"back off by the amount the server
asked for, and give up rather than hammer."**

**The API currently ships with admission control disabled specifically because this
contract is not yet implemented in clients.** Implementing it is what unblocks enabling it.

---

## What the API sends

### Status and headers

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 10

{"status":429,"message":"The server is busy processing other large requests. Please retry shortly."}
```

- **`Retry-After` is always present** on a 429 from this API, as an integer number of
  seconds. Never assume it is absent, but do tolerate it being missing (see §4).
- The body is JSON with `status` and `message`. **Do not parse the message text** — it is
  for humans and may change. Branch on the status code.

### Two sources, same contract

| source | when | typical `Retry-After` |
|---|---|---|
| **API admission control** (Layer 1) | concurrent heavy requests exceed the pool | 1–10 s |
| **Solr** (circuit breakers / rate limiter) | the search cluster itself is shedding | whatever Solr sends |

A client cannot and need not distinguish them — the handling is identical. A Solr-origin
429 is rarer and signals a more serious condition.

### What counts as "heavy"

Admission control classifies requests. Only **heavy** ones are realistically shed:

- `rows >= 10000`, or
- a download (`http_download=true` / `download` header), or
- a streaming request

Ordinary grid pages and single-document fetches use a much larger pool and are very
unlikely to see a 429.

---

## Required client behavior

### 1. Honour `Retry-After` — do not substitute your own delay

```
wait = Retry-After seconds (from the response header)
```

If the server says 10 seconds, waiting 1 second is a violation of this spec, not an
optimisation. The value is derived from how long the server expects to stay busy.

### 2. Add jitter

Multiple clients shed at the same instant will otherwise return at the same instant,
reproducing the burst.

```
actual_wait = Retry-After × (1.0 + random(0, 0.3))
```

### 3. Cap the number of retries

**Three retries maximum**, then surface the failure to the user. A 429 that persists past
three backoffs means the system is genuinely saturated; continuing to retry is
indistinguishable from an attack.

### 4. If `Retry-After` is missing or unparseable

Fall back to exponential backoff starting at **2 s**, doubling, with the same 3-retry cap
and the same jitter. Never fall back to an immediate retry.

### 5. Never retry in a tight loop, ever

No `while (status === 429) retry()` without a delay and a cap. This is the single
behavior this document exists to prevent.

### 6. Do not escalate concurrency in response to a 429

A shed request means the server is at capacity. Opening more connections — or splitting
the request into parallel pieces — converts a slowdown into an outage.

### 7. Tell the user something true

A 429 is not an error in the user's request. Surface it as a transient condition:

> *"The server is busy. Retrying in 10 seconds…"*

and, after retries are exhausted:

> *"The server is currently busy. Please try again in a few minutes."*

Do **not** report it as a failed query, a network error, or an empty result set. The last
of these is the worst outcome: a user who sees zero rows will believe their data is
missing.

---

## Reference implementation

```javascript
async function requestWithBackoff (doRequest, { maxRetries = 3 } = {}) {
  let attempt = 0
  for (;;) {
    const res = await doRequest()
    if (res.status !== 429 && res.status !== 503) {
      return res
    }
    if (attempt >= maxRetries) {
      throw new Error(
        'The server is currently busy. Please try again in a few minutes.')
    }

    // Honour the server's own figure; fall back to exponential backoff.
    const header = parseInt(res.headers['retry-after'], 10)
    const baseSeconds = Number.isFinite(header) && header >= 0
      ? header
      : 2 * Math.pow(2, attempt)

    // Jitter, so simultaneously-shed clients do not return simultaneously.
    const waitMs = baseSeconds * 1000 * (1 + Math.random() * 0.3)

    attempt++
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}
```

```python
import random, time

def request_with_backoff(do_request, max_retries=3):
    attempt = 0
    while True:
        resp = do_request()
        if resp.status_code not in (429, 503):
            return resp
        if attempt >= max_retries:
            raise RuntimeError(
                "The server is currently busy. Please try again in a few minutes.")

        try:
            base = int(resp.headers.get("Retry-After", ""))
        except ValueError:
            base = 2 * (2 ** attempt)

        time.sleep(base * (1 + random.random() * 0.3))
        attempt += 1
```

---

## Per-client requirements

| client | required change | notes |
|---|---|---|
| **`P3DataAPI` (Perl)** | backoff in the common request path | **Highest priority.** It issues `limit(25000)` on every `query_cb`, which classifies as heavy, so it is the most likely client to be shed. |
| **CLI tools (`p3-*`)** | inherit from `P3DataAPI`; print a "server busy, retrying" notice | A silent 10 s pause looks like a hang. |
| **Website (BV-BRC web app)** | backoff in the grid/download layer, plus a user-visible busy state | Must **not** render a shed request as an empty result set. |
| **Direct `curl`/script users** | documented, not enforced | Worth a note in the API docs. |
| **`scripts/replay-queries.js`** | treat 429 as retriable, not as a diff | Otherwise a shed request reads as a response mismatch. |

---

## Related: `503 Service Unavailable`

Handle identically. The API emits 503 with `Retry-After` under the same machinery, and the
distinction (busy vs temporarily unavailable) does not change what a client should do.

## Not to be confused with

| status | meaning | retry? |
|---|---|---|
| **429** | server busy, shedding load | **yes**, per this spec |
| **503** | temporarily unavailable | **yes**, identically |
| **504** | an upstream Solr request timed out | no — the query was too expensive; retrying repeats the cost |
| **400** | the request was refused on its merits, e.g. a taxon matching too many genomes | **no** — it will be refused identically. Read the message and narrow the query. |

The 400 case is worth calling out: broad-taxon queries now return
`"This query matches 15,627,061 genomes, which is too many to process (limit 150,000).
Please narrow the filter…"`. That is a permanent condition for that query, and a retry
wastes a round trip.

---

## Verifying a client implementation

With admission control enabled on a test deployment, drive enough concurrent heavy
requests to exceed the pool:

```bash
node scripts/verify-protections.js <endpoint> --expect-429 --concurrency 40
```

Then confirm the client under test:

1. receives 429s and does not error out,
2. waits approximately `Retry-After` seconds (not less),
3. gives up after 3 attempts rather than looping,
4. shows the user a busy message rather than an empty result,
5. does **not** increase concurrency while backing off.

Point 2 is the one worth measuring rather than eyeballing — a client that "handles 429" by
retrying after 100 ms is worse than one that fails immediately.

---

## Server-side notes for maintainers

`Retry-After` is emitted from two places, and both are required:

- `middleware/QueryClassifier.js` sets it on an admission rejection, derived from the
  pool's configured wait deadline.
- `app.js`'s terminal error handler sets it for any 429/503 carrying `retryAfterMs` —
  principally a Solr-origin shed, where the value is parsed from Solr's own response by
  `lib/solrHttpError.js`.

The second was missing until 2026-10-16: a Solr circuit breaker tripping produced a bare
429 with no guidance, which is the worst case for client behavior because it happens when
the cluster is already struggling.

Minimum emitted value is **1 second** — a `Retry-After: 0` invites exactly the tight loop
this document prohibits.
