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

**First decide which kind of client you are**, because one rule differs and it is the
rule that matters most:

| | **interactive** | **unattended** |
|---|---|---|
| examples | website, a `p3-*` command at a terminal | pipeline stage, batch download, scheduled sync, `p3-*` in a script |
| someone is waiting | yes | no |
| on persistent 429 | **give up after 3 tries** and say so — a stalled UI is worse than an honest error | **never give up on attempt count**; slow to a ceiling and keep going until the work completes |
| why | the person can retry later, or change what they asked for | nobody is there to restart it; abandoning the job loses work |

Everything else — honour `Retry-After`, jitter, no tight loops, no concurrency escalation
— applies to both. If you are unsure which you are building, assume **unattended**: its
failure mode is a slow job, while the other's is lost work.

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

### 3. Cap the number of retries — for *interactive* clients

**Three retries maximum**, then surface the failure to the user. A 429 that persists past
three backoffs means the system is genuinely saturated, and a person is waiting: tell them
rather than stalling.

**This cap is wrong for long-running work.** A batch job, a pipeline stage or an overnight
download that abandons after three attempts has lost data, and "please try again in a few
minutes" is advice nobody is there to act on. See §3a.

### 3a. Long-running clients: keep retrying, but slow down without bound

For anything unattended — batch jobs, pipelines, bulk downloads, scheduled syncs — giving
up is the wrong failure mode. Keep going, but make continued retrying *cheap for the
server*:

- **Cap the delay, not the attempt count.** Escalate the backoff until it reaches a ceiling
  — **5 minutes is a good default** — then keep retrying at that interval indefinitely, or
  until a deadline the operator set.
- **Honour `Retry-After` as a floor, not a target.** If the server says 10 s but you have
  already been shed eight times, wait your escalated interval, not 10 s. The server's
  figure is its estimate for one request; your history tells you the condition is
  persistent.
- **A client retrying every 5 minutes is not a problem.** One request per 300 s is
  negligible load, and it means the job completes on its own when capacity returns instead
  of requiring a human to restart it. That is the outcome to design for.
- **Log the backoff** so an operator watching the job can see it is waiting rather than
  hung — a silent 5-minute pause looks like a crash.
- **Set an overall deadline if you need one**, and make it a wall-clock budget the operator
  chose (`--max-wait 6h`), not an attempt count. Attempt counts are meaningless once the
  interval is capped.
- **Checkpoint before giving up.** If a bulk job does eventually abort, it should resume
  from where it stopped rather than restart. That matters far more than the retry policy.

The reason the interactive cap exists at all is that a person is waiting and a stalled UI
is worse than an honest error. Neither half of that applies to a batch job.

**Escalation schedule** (suggested, with jitter at every step):

```
attempt 1-3    honour Retry-After exactly
attempt 4-6    30 s
attempt 7-10   60 s
attempt 11+    300 s  (ceiling — hold here indefinitely)
```

### 4. If `Retry-After` is missing or unparseable

Fall back to exponential backoff starting at **2 s**, doubling, with the same jitter and
the same cap rule as §3/§3a for your client type. Never fall back to an immediate retry.

### 5. Never retry in a tight loop, ever

No `while (status === 429) retry()` without a delay between attempts. This is the single
behavior this document exists to prevent.

Note this is about the **interval**, not the attempt count — an unattended job retrying
indefinitely at a 5-minute ceiling (§3a) is fine and is what we want; a job retrying three
times with no delay is not.

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

Both forms below are the same function: an escalating backoff that either stops at a
retry cap (interactive) or holds at a delay ceiling forever (unattended). Pick the mode
by what is waiting at the other end — a person, or nothing.


```javascript
/**
 * @param doRequest          async () => response
 * @param mode               'interactive' (give up, a person is waiting)
 *                           'unattended'  (never give up; slow to a ceiling)
 * @param maxRetries         interactive only
 * @param ceilingSeconds     unattended only — hold here indefinitely
 * @param maxTotalWaitMs     unattended only — optional operator-set wall-clock budget
 * @param onBackoff          called before each wait; log it, or a 5-minute pause
 *                           looks like a hang
 */
async function requestWithBackoff (doRequest, {
  mode = 'interactive',
  maxRetries = 3,
  ceilingSeconds = 300,
  maxTotalWaitMs = Infinity,
  onBackoff = () => {}
} = {}) {
  let attempt = 0
  let totalWaited = 0

  for (;;) {
    const res = await doRequest()
    if (res.status !== 429 && res.status !== 503) {
      return res
    }

    // Interactive: stop and tell the person. Unattended: only an operator-set
    // wall-clock budget stops us, never an attempt count.
    if (mode === 'interactive' && attempt >= maxRetries) {
      throw new Error('The server is currently busy. Please try again in a few minutes.')
    }
    if (totalWaited >= maxTotalWaitMs) {
      throw new Error(`Gave up after waiting ${Math.round(totalWaited / 1000)}s for capacity.`)
    }

    const header = parseInt(res.headers['retry-after'], 10)
    const serverAsked = Number.isFinite(header) && header >= 0 ? header : null

    let baseSeconds
    if (mode === 'unattended') {
      // Escalate past the server's figure: it estimates one request, but our history
      // says the condition is persistent. Treat Retry-After as a floor.
      const escalated = attempt < 3 ? (serverAsked ?? 2 * Math.pow(2, attempt))
        : attempt < 6 ? 30
          : attempt < 10 ? 60
            : ceilingSeconds
      baseSeconds = Math.min(Math.max(escalated, serverAsked ?? 0), ceilingSeconds)
    } else {
      baseSeconds = serverAsked ?? 2 * Math.pow(2, attempt)
    }

    // Jitter, so simultaneously-shed clients do not return simultaneously.
    const waitMs = baseSeconds * 1000 * (1 + Math.random() * 0.3)

    onBackoff({ attempt: attempt + 1, waitMs, status: res.status })
    attempt++
    totalWaited += waitMs
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}
```

```python
import random, time

def request_with_backoff(do_request, mode="interactive", max_retries=3,
                         ceiling_seconds=300, max_total_wait=float("inf"),
                         on_backoff=lambda **kw: None):
    """mode='interactive' gives up so a waiting person gets an answer.
       mode='unattended' never gives up on attempt count; it slows to a ceiling."""
    attempt = 0
    total_waited = 0.0

    while True:
        resp = do_request()
        if resp.status_code not in (429, 503):
            return resp

        if mode == "interactive" and attempt >= max_retries:
            raise RuntimeError(
                "The server is currently busy. Please try again in a few minutes.")
        if total_waited >= max_total_wait:
            raise RuntimeError(
                f"Gave up after waiting {int(total_waited)}s for capacity.")

        try:
            server_asked = int(resp.headers.get("Retry-After", ""))
        except ValueError:
            server_asked = None

        if mode == "unattended":
            # Retry-After is a floor; our history says the condition is persistent.
            if attempt < 3:
                escalated = server_asked if server_asked is not None else 2 * (2 ** attempt)
            elif attempt < 6:
                escalated = 30
            elif attempt < 10:
                escalated = 60
            else:
                escalated = ceiling_seconds
            base = min(max(escalated, server_asked or 0), ceiling_seconds)
        else:
            base = server_asked if server_asked is not None else 2 * (2 ** attempt)

        wait = base * (1 + random.random() * 0.3)
        on_backoff(attempt=attempt + 1, wait=wait, status=resp.status_code)
        attempt += 1
        total_waited += wait
        time.sleep(wait)
```

---

## Per-client requirements

| client | mode | required change |
|---|---|---|
| **`P3DataAPI` (Perl)** | **both** | **Highest priority.** It issues `limit(25000)` on every `query_cb`, so it classifies as heavy and is the most likely client to be shed. It is used *both* interactively and inside pipelines, so it must expose the mode rather than hardcode one — default unattended when not a TTY is a reasonable heuristic, but let the caller override. |
| **CLI tools (`p3-*`)** | interactive | Inherit from `P3DataAPI`; print a "server busy, retrying in Ns" notice. A silent pause looks like a hang. |
| **`p3-*` in a pipeline or script** | **unattended** | The same binaries are routinely run non-interactively. Honour an explicit flag (`--max-wait`), and consider defaulting to unattended when stdout is not a TTY. |
| **pattyfam / app_service pipeline stages** | **unattended** | Long-running, no operator present, and a lost stage means recomputing hours of work. Checkpointing matters more here than the retry policy. |
| **Website (BV-BRC web app)** | interactive | Backoff in the grid/download layer plus a visible busy state. Must **not** render a shed request as an empty result set. |
| **Bulk/scheduled downloads** | **unattended** | Ceiling backoff; resume from checkpoint rather than restart. |
| **Direct `curl`/script users** | — | Documented, not enforced. Worth a note in the API docs. |
| **`scripts/replay-queries.js`** | unattended | Treat 429 as retriable, not as a diff — otherwise a shed request reads as a response mismatch. |

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

**Interactive clients:**

1. receive 429s and do not error out,
2. wait approximately `Retry-After` seconds (not less),
3. give up after 3 attempts rather than looping,
4. show the user a busy message rather than an empty result,
5. do **not** increase concurrency while backing off.

**Unattended clients** — the cases that matter most, since nobody is watching:

6. **complete successfully once capacity returns**, however long that takes. Shed a job
   for ten minutes and it should still finish, not abort.
7. escalate the interval to the ceiling and **hold there** — check the backoff log shows
   waits growing to ~300 s rather than retrying at the server's original `Retry-After`
   forever,
8. log each backoff, so the job is visibly waiting rather than apparently hung,
9. stop only on an operator-set wall-clock budget, never on an attempt count,
10. resume from a checkpoint if they do abort.

Point 6 is the one to test deliberately: hold the server in a shedding state for several
minutes, then release it, and confirm the job finishes on its own with no human
intervention. That is the whole purpose of unattended mode.

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
