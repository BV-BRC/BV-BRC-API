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
# unauthenticated GET to the public URL writes exactly the entry the website reads. No
# special endpoint, no credentials.
#
# TTL is a hard Redis expiry set at write time (`redis.expire(key, duration/1000)`), not a
# sliding window — an entry dies 24h after it was written however often it is read. So a
# daily run is not merely sufficient, it is required.
#
# WHICH TAXA
#
# Derived, not guessed: the intersection of (a) taxa whose genome count exceeds the reject
# threshold and (b) taxa actually requested, from three days of access logs. 74 taxa are
# over the threshold; only 22 of them were requested at all; the other 52 would be pure
# waste. The long tail of ~120,000 one-hit taxa is irrelevant — those are under the
# threshold and answer in normal time.
#
# Usage:
#   ./warm-taxon-summaries.sh                    # all 22, sequential
#   ./warm-taxon-summaries.sh --top6             # the 6 covering ~79% of the traffic
#   BASE=https://alpha.bv-brc.org/api ./warm-taxon-summaries.sh
#   DRY_RUN=1 ./warm-taxon-summaries.sh          # print what it would do
#
# Crontab (nightly, off-peak — this is hours of work, not minutes):
#   17 2 * * *  /path/to/warm-taxon-summaries.sh >> /var/log/warm-taxa.log 2>&1
#
# Exit status is the number of taxa that failed, so cron mail only arrives on trouble.

set -uo pipefail

BASE="${BASE:-https://www.bv-brc.org/api}"
TIMEOUT="${TIMEOUT:-3600}"          # per taxon; Viruses measured 32.8 min
PAUSE="${PAUSE:-5}"                 # breathing room between taxa
DRY_RUN="${DRY_RUN:-0}"
UA="${UA:-bvbrc-api/warm-taxa}"

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

FAILED=0
START=$(date +%s)

for t in "${TAXA[@]}"; do
  url="${BASE}/data/summary_by_taxon/${t}"

  # Skip a taxon whose genomes have not changed since the cached entry would have been
  # written. One cheap query; most taxa ingest rarely (taxon 1773's newest genome is from
  # April), so this usually skips nearly everything after the first run of the day.
  newest=$(curl -s -m 60 -H "User-Agent: $UA" \
    "${BASE}/genome/?eq(taxon_lineage_ids,${t})&sort(-date_inserted)&limit(1)&select(date_inserted)&http_accept=application/json" \
    2>/dev/null | sed -n 's/.*"date_inserted":"\([^"]*\)".*/\1/p')

  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] $t  newest_genome=${newest:-unknown}"
    continue
  fi

  t0=$(date +%s)
  code=$(curl -s -m "$TIMEOUT" -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" "$url")
  el=$(( $(date +%s) - t0 ))

  case "$code" in
    200) printf '  %-9s OK    %5ds  newest=%s\n' "$t" "$el" "${newest:-?}" ;;
    000) printf '  %-9s TIMEOUT after %ds — raise TIMEOUT or investigate\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    400) printf '  %-9s HTTP 400 (%ds) — is joinResolution.slicedSummary enabled?\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    *)   printf '  %-9s HTTP %s (%ds)\n' "$t" "$code" "$el"
         FAILED=$((FAILED+1)) ;;
  esac

  sleep "$PAUSE"
done

echo "### done in $(( ($(date +%s) - START) / 60 )) min, ${FAILED} failure(s)"

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
