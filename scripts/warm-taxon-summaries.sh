#!/usr/bin/env bash
#
# warm-taxon-summaries.sh — keep /data/summary_by_taxon warm for the broad taxa.
#
# WHY THIS EXISTS
#
# summary_by_taxon asks genome_feature for per-feature_type counts across a whole taxon,
# via a crossCollection join. Above joinResolution.rejectMaxGenomes (150,000) that join is
# refused; with joinResolution.slicedSummary enabled it is instead computed by slicing the
# genome set and summing the per-slice facets, which is correct (facet counts are additive
# over disjoint slices) and ~10x cheaper than the join — but SLOW. Viruses measured at
# 32.8 minutes: 783 slices over 15,643,163 genomes.
#
# That is fine for a cache fill and useless inside a user request: the caller disconnects
# long before it finishes, apicache's onlyStatus200 then stores nothing, and the next
# visitor starts over. So the fill has to be driven by something with no client attached.
#
# The cache key is `req.originalUrl` and nothing else (apicache.js:620), so an ordinary
# GET to the public path writes exactly the entry the website reads.
#
# A PLAIN GET IS NOT ENOUGH, THOUGH, AND THE EARLIER VERSION OF THIS SCRIPT DID NOTHING.
#
# TTL is a hard Redis expiry set at write time (`redis.expire(key, duration/1000)`), not a
# sliding window, and a cache HIT returns at apicache.js:649 before any handler runs — so
# reads never extend an entry. A warmer on a 24h cycle against a 24h TTL therefore races
# its own expiry: run slightly early and every request is a free hit, nothing is
# refilled, and the entry dies hours later in front of a real user.
#
# Measured on alpha 2026-10-29: 21 of 22 taxa returned in 0-1s and the run reported
# "done in 4 min, 1 failure(s)" having warmed nothing. Cached vs cold, same taxon, same
# work: 11646 0.16s vs 56.0s; 11676 0.28s vs 52.6s; 543 0.20s vs 16.2s.
#
# So each taxon is INVALIDATED first (POST /admin/cache/invalidate/...), which forces the
# following GET to miss and refill under the clean key with a full fresh TTL. That
# endpoint is loopback-only, which is why BASE now defaults to 127.0.0.1 — see the
# comment on BASE below for the three separate reasons that matters.
#
# WHICH TAXA
#
# Derived, not guessed: the intersection of (a) taxa whose genome count exceeds the reject
# threshold and (b) taxa actually requested, from three days of access logs. 74 taxa are
# over the threshold; only 22 of them were requested at all; the other 52 would be pure
# waste. The long tail of ~120,000 one-hit taxa is irrelevant — those are under the
# threshold and answer in normal time.
#
# Usage (ADMIN_TOKEN is required; the script refuses to run uselessly without it):
#   ADMIN_TOKEN=xxx ./warm-taxon-summaries.sh              # all 22, sequential
#   ADMIN_TOKEN=xxx ./warm-taxon-summaries.sh --top6       # 6 taxa, ~79% of the traffic
#   DRY_RUN=1 ./warm-taxon-summaries.sh                    # print what it would do
#   NO_INVALIDATE=1 ./warm-taxon-summaries.sh              # fill only already-cold entries
#
# Crontab (nightly, off-peak — this is hours of work, not minutes). Cron output goes to
# the admin list, so the per-taxon lines are the report:
#   17 2 * * *  ADMIN_TOKEN=xxx /path/to/warm-taxon-summaries.sh
#
# Exit status is the number of failures. A taxon served from cache AFTER a successful
# invalidate counts as a failure, because it means no warming happened — a fast green run
# that does nothing is the exact failure this script already had once.

set -uo pipefail

# Loopback BY DEFAULT, and that is load-bearing in three separate ways:
#
#   1. INVALIDATION. Without it the warmer does nothing. apicache sets a key's TTL only
#      on a WRITE (apicache.js:140) and a cache HIT returns before any handler runs
#      (:649), so reads never extend an entry. A warmer on a 24h cycle against a 24h TTL
#      races its own expiry: run slightly early and every request is a free cache hit.
#      Measured on alpha 2026-10-29 — 21 of 22 taxa returned in 0-1s and the run reported
#      "done in 4 min, 1 failure(s)" while refilling NOTHING. Cached vs cold for the same
#      taxon: 0.16s vs 56.0s. /admin/cache/invalidate is only reachable over loopback.
#   2. CLOUDFLARE. Taxon 11118 (9,468,441 genomes) 524s after 125s through the public URL
#      on alpha AND production — the edge silence budget cuts the fill long before
#      TIMEOUT below is relevant. Loopback does not traverse Cloudflare.
#   3. The admin gate requires a LOOPBACK PEER. This host reaches itself over its public
#      address (netstat shows 140.221.39.6 -> 140.221.39.6), and the previous version of
#      this script used https://alpha.bv-brc.org/api — which the gate refuses. Use
#      127.0.0.1 explicitly; a hostname that resolves to the public address will 403.
#
# Set BASE to a public URL only for a read-only check; warming will not work.
BASE="${BASE:-http://127.0.0.1:13001}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"      # required for invalidation; see PLAN_ADMIN_ENDPOINT.md
TIMEOUT="${TIMEOUT:-3600}"          # per taxon; Viruses measured 32.8 min
PAUSE="${PAUSE:-5}"                 # breathing room between taxa
DRY_RUN="${DRY_RUN:-0}"
NO_INVALIDATE="${NO_INVALIDATE:-0}" # skip invalidation (then this only fills COLD entries)
UA="${UA:-bvbrc-api/warm-taxa}"

# A fill does real work and takes seconds to minutes. Anything faster than this was served
# from cache, which means no warming happened. Reported distinctly, because a run that is
# fast and green while doing nothing is exactly how this went unnoticed for weeks.
HIT_THRESHOLD_S="${HIT_THRESHOLD_S:-2}"

# Ordered by hit count over three days. Bacteria and Viruses dominate (236 and 162 hits);
# everything after Coronaviridae is a shallow tail.
ALL_TAXA=(
  2        # Bacteria                                 236 hits   1,374,321 genomes
  10239    # Viruses                                  162       15,649,221
  11308    # Orthomyxoviridae                          21        2,225,057
  2955291  # Alphainfluenzavirus influenzae            20        1,961,086
  3052230  # Hepacivirus hominis                       13          278,932
  2697049  # SARS-CoV-2                                11        9,422,196
  11118    # Coronaviridae                             10        9,497,045
  197911   # Alphainfluenzavirus                        9        1,961,102
  11050    # Flaviviridae                               8          441,937
  3151693  # Bunyaviricetes                             7          367,818
  12058    # Picornaviridae                             7          209,878
  12059    # Enterovirus                                7          151,608
  2732541  # Reovirales                                 5          214,603
  11320    # Influenza A virus (legacy id)              4        1,955,539
  543      # Enterobacteriaceae                         2          254,911
  10912    # Rotavirus                                  2          163,427
  11646    # Lentivirus                                 1        1,212,446
  3418650  # Lentivirus humimdef1                       1        1,099,453
  11676    # HIV-1                                      1        1,099,453
  1239     # Bacillota                                  1          326,765
  11102    # Hepacivirus                                1          281,302
  2497574  # Monjiviricetes                             1          241,874
)

# ~1.1 hours instead of ~1.8, for 460 of 583 hits.
TOP6_TAXA=(2 10239 11308 2955291 2697049 11118)

TAXA=("${ALL_TAXA[@]}")
[ "${1:-}" = "--top6" ] && TAXA=("${TOP6_TAXA[@]}")

echo "### warm-taxon-summaries  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "### base=$BASE  taxa=${#TAXA[@]}  timeout=${TIMEOUT}s"

# Refuse to run uselessly rather than produce a green report that warms nothing. This is
# the failure the 2026-10-29 run hid.
if [ "$NO_INVALIDATE" != "1" ] && [ -z "$ADMIN_TOKEN" ]; then
  echo "### ERROR: ADMIN_TOKEN is not set."
  echo "###   Without invalidation every already-cached taxon is a no-op cache hit and"
  echo "###   nothing is refilled. Set ADMIN_TOKEN (see PLAN_ADMIN_ENDPOINT.md), or set"
  echo "###   NO_INVALIDATE=1 to deliberately fill only entries that are already cold."
  exit 1
fi
[ "$NO_INVALIDATE" = "1" ] && echo "### NO_INVALIDATE=1 — only cold entries will be filled"

FAILED=0
HITS=0
START=$(date +%s)

for t in "${TAXA[@]}"; do
  url="${BASE}/data/summary_by_taxon/${t}"
  # The apicache key is req.originalUrl as the PUBLIC route saw it — no host, no
  # BASE prefix. Keep these two in step: invalidating the wrong key reports success and
  # changes nothing.
  cache_path="/data/summary_by_taxon/${t}"

  # Skip a taxon whose genomes have not changed since the cached entry would have been
  # written. One cheap query; most taxa ingest rarely (taxon 1773's newest genome is from
  # April), so this usually skips nearly everything after the first run of the day.
  newest=$(curl -s -m 60 -H "User-Agent: $UA" \
    "${BASE}/genome/?eq(taxon_lineage_ids,${t})&sort(-date_inserted)&limit(1)&select(date_inserted)&http_accept=application/json" \
    2>/dev/null | sed -n 's/.*"date_inserted":"\([^"]*\)".*/\1/p')

  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] $t  newest_genome=${newest:-unknown}  invalidate=${cache_path}"
    continue
  fi

  # Expire the entry so the fetch below MISSES and runs the real handler chain, which is
  # what causes apicache to store a fresh value with a full TTL (hset + expire are
  # reissued together on every write). Without this step an already-cached taxon is a
  # free hit and no warming occurs.
  inval=''
  if [ "$NO_INVALIDATE" != "1" ]; then
    inval=$(curl -s -m 30 -X POST -H "User-Agent: $UA" -H "X-Admin-Token: ${ADMIN_TOKEN}" \
      -w '\n%{http_code}' "${BASE}/admin/cache/invalidate${cache_path}" 2>/dev/null | tail -1)
    if [ "$inval" != "200" ]; then
      printf '  %-9s INVALIDATE FAILED (http %s) — not warming; check ADMIN_TOKEN and that BASE is loopback\n' \
        "$t" "${inval:-000}"
      FAILED=$((FAILED+1))
      sleep "$PAUSE"
      continue
    fi
  fi

  t0=$(date +%s)
  code=$(curl -s -m "$TIMEOUT" -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" "$url")
  el=$(( $(date +%s) - t0 ))

  case "$code" in
    200)
      # A real fill takes seconds to minutes. Sub-threshold means this was served from
      # cache, so nothing was warmed -- which after a successful invalidate means
      # something is wrong (wrong key, wrong Redis db, another process refilled it).
      if [ "$el" -lt "$HIT_THRESHOLD_S" ] && [ "$NO_INVALIDATE" != "1" ]; then
        printf '  %-9s CACHE HIT (%ds) — NOT warmed; invalidate did not take effect\n' "$t" "$el"
        HITS=$((HITS+1))
        FAILED=$((FAILED+1))
      elif [ "$el" -lt "$HIT_THRESHOLD_S" ]; then
        printf '  %-9s hit   %5ds  (already cached; NO_INVALIDATE)\n' "$t" "$el"
        HITS=$((HITS+1))
      else
        printf '  %-9s FILLED %4ds  newest=%s\n' "$t" "$el" "${newest:-?}"
      fi
      ;;
    000) printf '  %-9s TIMEOUT after %ds — raise TIMEOUT or investigate\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    400) printf '  %-9s HTTP 400 (%ds) — is joinResolution.slicedSummary enabled?\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    502|503|504)
         printf '  %-9s HTTP %s (%ds) — upstream refused/timed out\n' "$t" "$code" "$el"
         FAILED=$((FAILED+1)) ;;
    524) printf '  %-9s HTTP 524 (%ds) — Cloudflare cut the fill; BASE must be loopback\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    *)   printf '  %-9s HTTP %s (%ds)\n' "$t" "$code" "$el"
         FAILED=$((FAILED+1)) ;;
  esac

  sleep "$PAUSE"
done

echo "### done in $(( ($(date +%s) - START) / 60 )) min, ${FAILED} failure(s), ${HITS} cache hit(s)"
if [ "$HITS" -gt 0 ] && [ "$NO_INVALIDATE" != "1" ]; then
  echo "### WARNING: ${HITS} taxa were served from cache after invalidation — those were NOT"
  echo "###          warmed. Check that the apicache key matches ${BASE%/}/data/summary_by_taxon/<id>"
  echo "###          and that /admin talks to the same Redis db as the API."
fi

# NOTES
#
# SEQUENTIAL ON PURPOSE. Each fill is minutes of coordinator work; several at once would
# hold the pool for the duration. Do not parallelise this.
#
# REQUIRES joinResolution.slicedSummary. Without it every over-threshold taxon returns 400
# in under two seconds, which the loop reports distinctly so a misconfiguration is obvious
# rather than looking like a fast success.
#
# THE STALENESS CHECK IS INFORMATIONAL HERE. It records each taxon's newest genome but does
# not currently skip on it, because apicache exposes no write timestamp to compare against
# — adding one means either tracking fill times in this script's own state file or reading
# the Redis TTL directly (`TTL apicache:<url>`; a value near 86400 means freshly written).
# Left as the obvious next refinement; running unconditionally once a day is correct, just
# not minimal.
#
# IF THE ARCHITECTS PRECOMPUTE CDS TOTALS per taxon the way taxonomy.genomes already is,
# this script becomes unnecessary. Worth asking before investing more in it.

exit "$FAILED"
