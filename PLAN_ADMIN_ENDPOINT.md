# PLAN: an `/admin` endpoint, and the cache-refresh operation that needs it

**Status:** proposal. Measurements are from alpha, 2026-10-29.
**Motivating need:** the `summary_by_taxon` warmer does no work, and one taxon cannot be
warmed at all. Both are fixed by the same mechanism, and more admin operations are
expected, so it is worth building the door rather than cutting another hole.

---

## 1. Why the warmer needs this

`scripts/warm-taxon-summaries.sh` runs nightly against the public URL and **refills
nothing**. Measured on alpha, cached URL versus the identical query with a cache-busting
parameter (same work, different `apicache` key):

| taxon | cached | cold |
|---|---|---|
| 11646 | 0.16 s | **56.0 s** |
| 11676 | 0.28 s | **52.6 s** |
| 543 | 0.20 s | **16.2 s** |
| 3151693 | 0.25 s | **17.4 s** |

21 of 22 taxa in the 2026-10-29 run returned in 0–1 s. The run reported
`done in 4 min, 1 failure(s)` while doing essentially no warming.

**Why.** `apicache` sets the TTL only on a *write* (`apicache.js:140`,
`redis.expire(key, duration/1000)`), and a cache **hit returns at `:649` before any
handler runs**. Reads never extend the entry. So a 24 h TTL expires 24 h after its last
write however often it is read — and a warmer on a 24 h cycle races its own expiry: run
slightly early, every request is a free hit, nothing refills, and the entry dies hours
later in front of a real user.

Note the corollary, which is what makes the fix clean: **an apicache write always resets
the TTL**, because `hset` + `expire` are issued together on every store. A forced refill
buys a full fresh 24 h.

**And one taxon cannot be warmed through the front door at all.** Taxon 11118
(Coronaviridae, 9,468,441 genomes) returns **524 after 125 s on both alpha and
production** — Cloudflare's silence budget cuts the fill long before the script's
3600 s timeout is relevant. No scheduling change fixes that; it needs a path that does
not traverse Cloudflare.

---

## 2. Why a flag on the public endpoint does not work

The obvious `?refresh=1` fails for a specific reason worth recording, because it looks
like it should work.

`apicache`'s key is `req.originalUrl` verbatim (`apicache.js:620`) with `appendKey: []`.
**Any parameter you add changes the key.** `GET /data/summary_by_taxon/2?refresh=1`
writes an entry under *that* URL — a different entry from the one users read. You would
pay 56 s and warm a cache nobody hits.

So any forced-refresh design must **delete the clean key and refill under the clean
URL**, never fetch a decorated one. That is an operation, not a query parameter, which
is the first argument for a separate endpoint.

---

## 3. The deployment facts this design rests on

Established on alpha 2026-10-29. **Each one is load-bearing; re-verify before relying on
this plan elsewhere.**

- **nginx runs on a different host.** This is the fact that makes an address check
  meaningful: proxied traffic cannot present a loopback peer address.
- **The app binds all interfaces** — `netstat` shows `:::13001 LISTEN`, not
  `127.0.0.1:13001`.
- **Port 13001 is reachable from off-host.** Confirmed by the maintainer. So the address
  check is not a formality; it is the only thing standing in front of `/admin`.
- **The app has no `trust proxy` setting** (verified: zero matches in the tree), and
  `app.js:77` logs `req.headers['x-forwarded-for'] || req.connection.remoteAddress`.
  **The access log therefore shows client-supplied data**, which is why log inspection
  cannot answer "where did this really come from."
- **elm talks to itself over its public address.** `netstat` shows many
  `140.221.39.6:13001 ← 140.221.39.6:*` connections — on-host callers using the
  hostname, not loopback. The existing warmer is one of them: it uses
  `https://alpha.bv-brc.org/api`.

That last point is the trap. A strict loopback check **rejects** a caller that reaches
the service through its own public hostname, because the peer address is
`::ffff:140.221.39.6`, not `::1`. The admin caller must use `127.0.0.1` explicitly.

---

## 4. Proposed gate: two independent factors

### Factor 1 — the peer socket address, and nothing else

```js
// NOT req.ip. NOT x-forwarded-for. Those are client-supplied; this is not.
const peer = req.socket.remoteAddress
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
```

- **Must** read `req.socket.remoteAddress`. A TCP source address cannot be forged by an
  off-path attacker — completing a handshake requires receiving the SYN-ACK — whereas
  `X-Forwarded-For` is a header anyone may set.
- **Must** accept all three loopback spellings. This stack maps IPv4 into IPv6
  (`::ffff:` appears throughout the logs), so matching only `127.0.0.1` would reject
  real local callers and read as a bug.
- **Must not** be relaxed to "the host's own public address." That would admit anything
  able to spoof-or-route as elm, and the whole point is that reachability equals
  authorization.

Comment the *reason* at the call site: **this is sound only because nginx is on a
separate host.** If nginx is ever colocated, every proxied request becomes loopback and
this gate silently opens. That is a deployment fact a future reader cannot infer from
the code.

### Factor 2 — a shared token from config

```
admin: { enabled: false, token: null }     // tracked defaults
```

Required in addition to the address check, supplied as `X-Admin-Token`. Rationale:

- it survives the bind address changing, nginx moving on-host, or a firewall rule being
  dropped — each of which silently removes factor 1;
- with 13001 open to the world, one factor is thin for an endpoint whose whole purpose
  is triggering expensive work;
- the real token lives in the untracked `p3api.conf`, the same pattern as the Solr
  credentials and `excludeNodes`.

**Ship `enabled: false`.** An admin surface that appears by default on upgrade is the
wrong default, and the existing `queryAdmission`/`joinResolution` keys set the
precedent.

### What this is not

Not basic auth. It adds credential storage and rotation for no gain over a config token,
and browsers cache basic-auth credentials in ways that surprise people.

---

## 5. First operation: force a cache refill

```
POST /admin/cache/refresh/summary_by_taxon/:taxon_id
  1. gate (address + token)
  2. DEL the apicache key for the CLEAN public URL
  3. re-issue the query in-process, exactly as the public route would
  4. respond { taxon, refilled: true, elapsedMs, bytes }
```

Design notes:

- **Delete then refill, not refill then delete.** The window where a user request can
  arrive mid-refill and pay the full 56 s is unavoidable without a double-buffer; it is
  acceptable because the alternative today is that the entry expires in front of a user
  anyway. Worth stating in the response/log so a slow user request during a refresh is
  explicable.
- **Refill in-process**, not by self-calling the public port — the whole of
  `PLAN_ELIMINATE_SELF_CALL.md` applies, and a self-call here would also re-enter the
  cache middleware.
- **This bypasses Cloudflare**, which is the second win: a loopback-triggered refill of
  taxon **11118** is not subject to the 125 s edge budget, so the one taxon that cannot
  currently be warmed becomes warmable.

Then `scripts/warm-taxon-summaries.sh` changes `BASE` to `http://127.0.0.1:13001`, adds
the token header, and hits the admin route. It gains determinism (every run refills) and
loses the Cloudflare ceiling in one change.

---

## 6. Tests that must exist

The gate's failure mode is silent over-permission, so the negative cases are the point:

- a request from a non-loopback socket carrying `X-Forwarded-For: 127.0.0.1` is
  **rejected** — this is the regression that would otherwise be invisible, and it fails
  against any implementation that reads `req.ip`;
- same, with `X-Real-IP`, and with a spoofed `Host`;
- a loopback request with a wrong/absent token is rejected;
- a loopback request with the right token succeeds, for each of `127.0.0.1`, `::1`,
  `::ffff:127.0.0.1`;
- with `admin.enabled: false`, every route 404s — not 403, so the surface is not even
  advertised;
- the refresh actually **deletes the clean key and writes it back**: assert the post-
  refresh key exists with a TTL near the full duration. A test that only checks for
  HTTP 200 would pass against the broken `?refresh=1` design in §2.

---

## 7. Open questions

1. **Should 13001 be firewalled to the proxy host?** Independent of this plan, and
   better than any application-level control. The admin gate should not be the reason
   the port stays open to the world.
2. **Separate listener instead?** A second `app.listen` bound to `127.0.0.1` would make
   reachability *be* the authorization and need no address check. Rejected for now as
   more moving parts than a gate on the existing app, but it is the stronger form if
   `/admin` grows.
3. **What else belongs here?** Named so the shape is right the first time — cache
   inspection/clear for the other `/data` endpoints, join-resolver cache stats,
   admission-pool state per worker (`/stats` is per-worker; an admin view could
   aggregate), and a forced `joinResolution` cache flush.
4. **Per-worker state.** alpha runs 3 workers, so an admin call lands on one of them
   arbitrarily. For a Redis-backed cache refill that is fine — the store is shared. For
   anything touching in-process state (the join-resolver LRU, admission counters) a
   single call reaches **one worker only**, which is a trap for operation #3 above.
