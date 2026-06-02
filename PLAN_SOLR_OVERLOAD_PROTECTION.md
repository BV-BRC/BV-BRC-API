# Plan: Solr Query Overload Protection

## Context

A single IP (`58.250.174.76`) made parallel `POST /genome_sequence` requests using `libwww-perl/6.61` — 168 successful requests over 80 minutes, each returning ~2.8MB and taking 5-43 seconds. Multiple heavy queries in flight simultaneously drove Solr host load averages over 500. The problem is concurrent expensive queries saturating individual Solr nodes, not request rate.

This document surveys the available protection layers, their trade-offs, and the system-wide implications of each.

---

## Protection Layers Available

### Layer 1: HAProxy (edge, before API)

**Stick-table rate limiting** — per-source-IP request rate limiting at the load balancer:

```
frontend http
    stick-table type ip size 100k expire 1m store http_req_rate(1m)
    http-request track-sc0 src
    http-request deny deny_status 429 if { sc_http_req_rate(0) gt 60 }
```

**`retry-on 429`** — if a Solr backend returns 429, HAProxy retries on a different server:

```
backend solr_servers
    option redispatch
    retries 2
    retry-on 429
```

| Pros | Cons |
|------|------|
| Stops abuse before it reaches the API or Solr | No heavy/light classification |
| No code changes | POST retry requires care (though Solr queries are idempotent) |
| Per-IP rate limiting at the edge | If all backends are overloaded, retries cascade |
| Already deployed infrastructure | Rate-based, not concurrency-based |
| Protects against non-API clients too | Config changes require HAProxy reload |

**429 implications:** Clients hitting HAProxy rate limits get 429 directly. Currently no client (CLI tools, website) handles 429.

---

### Layer 2: Solr Circuit Breakers (per Solr node)

Solr 9.6 has built-in circuit breakers configured globally via `solr.in.sh` or per-collection via `solrconfig.xml`. Returns HTTP 429 when tripped.

**Types available:**

| Breaker | What it monitors | Scope | Key parameter |
|---------|-----------------|-------|---------------|
| `LoadAverageCircuitBreaker` | OS load average | Host-wide | `threshold` (float) |
| `CPUCircuitBreaker` | System CPU % via JMX | Host-wide | `threshold` (0-100) |
| `MemoryCircuitBreaker` | JVM heap usage | Per-JVM | `threshold` (50-95%) |

**Global configuration** (`solr.in.sh`):
```bash
SOLR_CIRCUITBREAKER_QUERY_LOADAVG=<threshold>
SOLR_CIRCUITBREAKER_QUERY_CPU=90
SOLR_CIRCUITBREAKER_UPDATE_LOADAVG=<threshold>
```

**Per-collection configuration** (`solrconfig.xml`):
```xml
<circuitBreaker class="solr.LoadAverageCircuitBreaker">
  <double name="threshold">50.0</double>
  <arr name="requestTypes"><str>QUERY</str></arr>
</circuitBreaker>
```

**Considerations:**

- **Load average threshold depends on host core count.** Load average measures runqueue depth; a "healthy" load average is roughly 1.0-2.0x the core count. Need to know core counts per host to set thresholds.
- **Host-wide scope for load/CPU breakers.** Each host runs multiple Solr JVMs on different ports. All JVMs on the same host see the same OS load average and would trip simultaneously. With 2-3 replicas per shard on different hosts, queries should fail over — but only if the caller handles 429 and tries a different replica.
- **Memory breaker is per-JVM.** Useful for preventing GC storms, independent of the load problem.
- **Query vs update separation.** Can set different thresholds for queries and updates, so indexing continues even when queries are throttled.

| Pros | Cons |
|------|------|
| Directly addresses the symptom (load > 500) | Must configure on every Solr node |
| Self-protection — works regardless of client | All JVMs on same host trip together |
| No API code changes to enable | Blunt — doesn't distinguish heavy vs light queries |
| Separate query/update thresholds | Callers must handle 429 (API, HAProxy, etc.) |
| Per-collection tuning possible | Load average threshold is host-dependent |

---

### Layer 3: Solr Rate Limiter (per Solr node)

Concurrent request slot-based limiter, configured via cluster API:

```json
{
  "set-ratelimiter": {
    "enabled": true,
    "allowedRequests": 20,
    "slotAcquisitionTimeoutInMS": -1,
    "slotBorrowingEnabled": false
  }
}
```

| Parameter | Purpose | Default |
|-----------|---------|---------|
| `enabled` | Activate | `false` |
| `allowedRequests` | Max concurrent requests | cores × 3 |
| `slotAcquisitionTimeoutInMS` | Wait time for slot (-1 = reject immediately) | -1 |
| `slotBorrowingEnabled` | Allow borrowing slots across request types | `false` |
| `guaranteedSlots` | Reserved slots when borrowing enabled | allowedRequests ÷ 2 |

Returns 429 when all slots are occupied.

| Pros | Cons |
|------|------|
| Concurrency-based (directly addresses the problem) | Instance-level, not per-collection |
| Slot-based — limits parallel queries on each node | Same 429 propagation issue |
| Configured via API call, no restart needed | Doesn't distinguish query cost |
| Works proactively (before load spikes) | `allowedRequests` needs tuning per host |

---

### Layer 4: API — HTTP Agent `maxSockets` (minimal code change)

Node.js `http.Agent({ maxSockets: N })` limits concurrent sockets **per host:port**. The distributed query system creates agents with `maxSockets: 50` (`DistributedQueryManager.js:67`). Lowering this limits concurrent queries to each Solr server.

| Pros | Cons |
|------|------|
| One config value change | No heavy/light classification |
| Per-host limiting built into Node.js | Queues silently — no 429, no observability |
| No new code | Only affects distributed query path, not proxy |
| Node.js handles queuing internally | Per-process — divide by instance count |

---

### Layer 5: API — Custom Admission Control (most code)

Custom middleware with request classification, per-server tracking, load-aware replica selection, and stats endpoint. Returns 429 when limits exceeded.

**Request classification** (after Limiter middleware, before Solr dispatch):
- **Heavy**: `rows >= 10000`, `isDownload`, or `call_method === 'stream'`
- **Interactive**: everything else

**Two levels:**
- Per-server concurrency for distributed queries (know the target host)
- Global heavy/interactive budgets for proxy queries

**Load-aware replica selection:** When choosing which replica to query for a shard, prefer replicas on servers with fewer active queries (currently random).

| Pros | Cons |
|------|------|
| Heavy/interactive budgets | Most complex, most code |
| Per-server tracking with observability | Per-process state — multi-instance needs coordination or division |
| Load-aware replica selection | Duplicates some of what Solr rate limiter does |
| Stats at `/stats` endpoint | Needs maintenance |
| 429 with Retry-After | |
| Works for both proxy and distributed paths | |

---

## 429 System-Wide Implications

Introducing 429 at **any** layer requires all downstream consumers to handle it. Currently none do.

### Affected components

| Component | Current 429 handling | What's needed |
|-----------|---------------------|---------------|
| **p3_api (APIMethodHandler.js)** | Treats any non-success Solr response as generic error | Propagate 429 to client with Retry-After header |
| **p3_api (ShardCursorStream.js)** | `_requestWithRetry()` retries same replica 3x | On 429: try a different replica, not the same one |
| **p3_api (DistributedQuery.js)** | Passes through errors | Propagate 429 to client |
| **CLI tools** | No 429 handling | Retry with exponential backoff on 429 |
| **Website (BV-BRC web app)** | No 429 handling | Show "server busy" message, retry automatically |
| **libwww-perl / external scripts** | No 429 handling (bad actor continued hitting after 403) | N/A — these get throttled, which is the point |
| **HAProxy** | Passes 429 through | Optionally: `retry-on 429` with `redispatch` to try another backend |

### Retry strategy for clients

Clients receiving 429 should:
1. Read `Retry-After` header (seconds to wait)
2. Wait that duration (or exponential backoff if no header)
3. Retry the same request
4. After N retries, surface error to user

### Risk of 429 without client support

If 429 is enabled at the Solr layer but clients don't handle it:
- CLI tools would report cryptic errors instead of retrying
- Website would show broken pages instead of "please wait"
- Scripts would fail and users would file bug reports

This suggests a **phased rollout**: implement 429 handling in clients first (or concurrently), then enable the server-side protections.

---

## Layered Strategy Options

### Option A: Solr-first (least code, most Solr config)

1. Enable Solr circuit breakers (load average + CPU) on all nodes
2. Enable Solr rate limiter with tuned `allowedRequests`
3. Configure HAProxy `retry-on 429` with `redispatch`
4. Update API to propagate 429 from Solr to clients
5. Update CLI tools and website to handle 429

API changes: small (429 propagation only). Solr config: per-node. Client changes: all consumers.

### Option B: API-first (most code, no Solr config)

1. Build API admission control with request classification
2. Lower `maxSockets` on distributed query HTTP agent
3. Update CLI tools and website to handle 429

API changes: significant. Solr config: none. Client changes: all consumers.

### Option C: Layered (defense in depth)

1. HAProxy stick-table rate limiting (edge protection, per-IP)
2. API admission control with classification (smart throttling)
3. Solr circuit breakers (safety net, self-protection)
4. All clients handle 429

Most robust but most work across all components.

### Option D: Incremental

1. **Immediate** — Lower `maxSockets` on distributed query agent (1 line, no 429, queues internally)
2. **Short-term** — API admission control with 429 + update clients
3. **Later** — Solr circuit breakers as safety net once 429 is handled everywhere

Starts with zero client impact, adds 429 support when clients are ready.

---

## Open Questions

- **Host core counts?** Needed to set load average circuit breaker thresholds
- **How many API instances?** Affects per-process limit division
- **HAProxy config access?** Can we modify the Solr backend config?
- **Client update scope?** Which CLI tools and website components need 429 support? How large is that effort?
- **Rollout order?** Can we enable protection server-side before clients support 429, accepting that some clients will see errors temporarily?
