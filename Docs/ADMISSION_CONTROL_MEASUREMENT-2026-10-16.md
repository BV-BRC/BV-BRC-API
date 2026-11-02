# Admission control, measured: paired A/B against alpha

**Date:** 2026-10-16
**Subject:** Layer 1 admission control (PR #231, Phase 2 of `Docs/COMPLETION_PLAN-2026-10.md`)
**Method:** identical sustained load against `alpha.bv-brc.org/api`, once with
`queryAdmission.enabled: true` and once with it `false`, with Solr JVM/GC sampled
throughout at 5 s resolution across all 97 JVMs.

---

## Summary

Admission control **roughly doubles download throughput, holds latency flat, keeps the
socket queue empty, and cuts filterCache churn per request by ~3x.**

It did **not** demonstrate heap protection, because at this load the cluster was never
under heap pressure — zero old-gen collections on all 97 JVMs in both runs. That is an
honest limitation of the experiment, not a null result for the feature; see "What this
does not establish."

---

## Method

**Generator:** `scripts/verify-protections.js --only=load --concurrency 40`, re-invoked
back-to-back for 250 s so the load is continuous rather than a single burst followed by
idle. Each request is a streaming CSV download:
`eq(genome_id,83332.12)&sort(+feature_id)&limit(25000)` — 2,850,853 bytes, 10,941 rows,
fanning out across 80 `genome_feature` shards.

**Sampler:** `sample-solr-jvm` (separate Solr tooling repo, spec in
`Docs/SPEC-solr-jvm-sampler.md`), 5 s interval, 97 nodes across 9 hosts, started ~60 s
before load and stopped after.

**Pool under test:** the shipped default — 3 slots, 6 queue, 10,000 ms wait.

| run | load window (UTC) | sampler window | ticks |
|---|---|---|---|
| admission ON | 18:40:57 – 18:45:37 | 18:39:53 – 18:46:23 | 79 |
| admission OFF | 18:54:10 – 18:59:00 | 18:52:54 – 19:02:24 | 115 |

Nine minutes apart, cluster quiet, swap disabled on balsam between the earlier trial runs
and these.

---

## API-side results

| | admission ON | admission OFF |
|---|---|---|
| passes completed in ~250 s | **27** | **12** |
| requests offered | 1,080 | 480 |
| requests reaching Solr | ~855 | **480 (all)** |
| shed with 429 | ~225 | 0 |
| per-pass latency, mean | **9.0 s** | **20.3 s** |
| per-pass latency, range | 7.4 – 10.0 s | 15.2 – 27.5 s |
| latency trend across passes | flat | **rising: 19.9 → 27.5 s** |
| peak socket queue (`agents.solr.main.queued`) | **0** | **17** |
| completed downloads/sec | 3.1 | 1.7 |
| truncated downloads | 0 | 0 |

### Throughput roughly doubled

27 passes versus 12 in the same wall time. **Metering to 3 concurrent did not cost
throughput — it nearly doubled it.** This is the counter-intuitive result and the
strongest argument for the feature: bounded concurrency finishes more work than unbounded
concurrency, because the unbounded case spends its capacity on contention.

### Latency degraded monotonically without admission

With admission, per-pass time stayed 7.4–10.0 s across all 27 passes with no trend.
Without it, passes ran 19.9 → 15.2 → 22.8 → 26.5 → **27.5 s**, climbing steadily. That is
queueing collapse: more concurrent work makes each unit slower, so more piles up behind it.

### The socket queue appeared only without admission

Peak `agents.solr.main.queued` was **0 in every one of the 27 ON passes** and reached
**17** without admission. This is the unbounded, previously-invisible queue inside Node's
`http.Agent` — the one `lib/agentStats.js` (Phase 0.3) was built to expose and that
admission control exists to keep empty.

The design rule from `Docs/ADMISSION_CONTROL_STATUS-2026-10.md` — *admission pool ≤ socket
pool, so the socket queue stays empty* — is now measured in both directions.

---

## Cluster-side results

### Heap: no usable signal either way

| | ON | OFF |
|---|---|---|
| cluster heap, pre-load mean | 618.5 GB | 638.3 GB |
| cluster heap, during-load mean | 629.7 GB | 644.5 GB |
| delta | +11.2 GB | **+6.2 GB** |
| old-gen collections, all 97 JVMs | **0** | **0** |
| sample gaps / failed probes | 0 | 0 |
| peak heap, worst single JVM | 55.4% | 55.9% |

**Both deltas are noise.** Background heap swings 594–654 GB on its own, wider than either
delta. The decisive detail is the *ordering*: the OFF run put strictly more concurrent work
on Solr and produced the **smaller** delta. If either number were measuring the load, OFF
would be the larger one. Neither is.

Per-host heap floors were +22 GB higher in the OFF window, but that run also started ~20 GB
higher at baseline, so the difference is drift rather than effect.

**Zero old-gen collections in both runs** is the most important single number here: at this
load the cluster does not notice 40-concurrent downloads, with or without admission.

### filterCache evictions: the one metric that discriminates

Counted in-window only and normalized, since the two windows differ in length and in
requests offered:

| | ON | OFF |
|---|---|---|
| evictions in window | 10,428 | 13,615 |
| evictions/sec | 37.9 | 47.8 |
| **evictions per offered request** | **9.7** | **28.4** |

Unmetered requests cost **~2.9× more cache churn each**. That is real work displaced from
the filterCache, and it is consistent with the API-side degradation — the same queries,
run with more contention, evict more of each other's cached filters.

This also closes the question raised in `Docs/SPEC-solr-jvm-sampler.md`: the
`{!terms f=genome_id cache=false}` filters emitted by the Phase 1 join rewrite **cannot** be
responsible for these evictions, because `cache=false` means they are never inserted. The
`cache=false` reasoning holds.

---

## What this does not establish

**It does not demonstrate heap-exhaustion protection.** The cluster was never close to
stressed: zero old-gen GC, peak heap ~55% on the single worst JVM and under 35% on most.
The OOM scenario Layer 1 was designed against is **not what this experiment reproduced**.

The 2026-06-25 crash came from broad-taxon cross-collection **joins** holding 57–93M-document
DocSets per shard for up to 330 s — not from concurrent downloads. That failure mode is
addressed by **Phase 1** (PR #230), which refuses those queries at the API before they reach
Solr, and which was independently verified: taxa above the threshold now return 400 in under
a second where they previously burned 120 s.

So the honest framing is:

- **Layer 1 (this measurement)** is validated as a *throughput, latency and contention*
  mechanism, with cache-pressure evidence supporting it.
- **The heap-protection case** rests on the June incident analysis and on Phase 1's join
  rejection — not on these runs.

Reproducing an actual heap-pressure event would require deliberately driving broad-taxon
joins with Phase 1 disabled. That is a destructive test against a production-adjacent
cluster and was not attempted.

## Other caveats

- **Baselines differed.** The OFF window started ~20 GB higher in cluster heap. With both
  signals this small relative to background, the heap comparison should not be pushed
  further without many more paired runs — and given zero GC pressure in both, more runs
  would likely only confirm the absence.
- **Single pair.** One ON run and one OFF run. The API-side differences (2.2× throughput,
  2.3× latency, 0 vs 17 socket queue) are large and consistent across 27 and 12 passes
  respectively, so they are unlikely to be chance; the cluster-side numbers are not.
- **Background load was present but quiet.** Earlier trials the same afternoon were
  contaminated by independent cluster activity and by balsam swapping; both were resolved
  before these two runs.

---

## Implications for tuning

**The pool may be tighter than necessary.** At 3 slots, 21% of offered requests were shed
(~225 of 1,080) while the cluster showed no stress at all. Raising `heavyMaxConcurrent` to 6
would shed far less while keeping concurrency well under the 8-socket Solr agent pool —
preserving the "socket queue stays empty" property that this measurement confirms matters.

**`heavyMaxWaitMs: 10000` looks about right, contrary to an earlier suggestion.** In this
run only 4 of ~85 rejections were wait-timeouts; almost everything shed immediately on
queue-full. An earlier run where most rejections were timeouts turned out to reflect a slow
cluster, not a misconfigured deadline.

**429s now reach real clients.** Nothing in the CLI or website honours `Retry-After` yet. A
client that retries tightly reproduces the amplification blamed for the 2026-06-05
coordinator crash, so enforcement should stay off in production until client support lands.

---

## Reproducing

```bash
# API side — sustained load, 250s of continuous pressure
end=$((SECONDS+250))
while [ $SECONDS -lt $end ]; do
  node scripts/verify-protections.js https://alpha.bv-brc.org/api \
    --only=load --concurrency 40
done

# assert shedding specifically (requires queryAdmission.enabled)
node scripts/verify-protections.js https://alpha.bv-brc.org/api \
  --expect-429 --concurrency 40

# cluster side, started ~60s before the load
sample-solr-jvm --duration 400 --label admission-on --out on.jsonl --summary
```

Read `/stats` immediately before and after each run — the admission counters are cumulative
since process start, so only the delta is meaningful per run.
