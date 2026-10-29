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
# So each taxon goes through POST /admin/cache/refresh/summary_by_taxon/<id>, which
# recomputes with X-Apicache-Bypass and then OVERWRITES the key.
#
# NOTE IT DOES NOT DELETE FIRST, and that is deliberate. apicache does no request
# coalescing, so deleting a key opens a hole lasting the whole fill during which every
# arriving request starts its own recomputation -- 32.8 minutes of that for taxon 10239.
# Overwriting means the old value serves readers throughout, and a failed refresh leaves
# it intact instead of destroying it.
#
# The endpoint is loopback-only, which is why BASE defaults to 127.0.0.1 -- see the
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
# Usage. The admin token is read from p3api.conf automatically, so there is nothing to
# configure here once admin.token is set there:
#   ./warm-taxon-summaries.sh                    # all 22, sequential
#   ./warm-taxon-summaries.sh --top6             # 6 taxa, ~79% of the traffic
#   DRY_RUN=1 ./warm-taxon-summaries.sh          # print what it would do
#   ADMIN_TOKEN=xxx ./warm-taxon-summaries.sh    # override, for an ad-hoc run
#
# Crontab (nightly, off-peak — this is hours of work, not minutes). Cron output goes to
# the admin list, so the per-taxon lines are the report:
#   17 2 * * *  /path/to/warm-taxon-summaries.sh
#
# No secret in the crontab: the token is read from p3api.conf, which also keeps it out of
# `ps` output and cron mail. The path is derived from this script's own location, so the
# job does not depend on cron's working directory.
#
# Exit status is the number of failures, so cron mail is actionable. A refresh that fails
# leaves the PREVIOUS cached value in place, so a bad run degrades to "no change" rather
# than to an empty cache.

set -uo pipefail

# Loopback BY DEFAULT, and that is load-bearing in three separate ways:
#
#   1. INVALIDATION. Without it the warmer does nothing. apicache sets a key's TTL only
#      on a WRITE (apicache.js:140) and a cache HIT returns before any handler runs
#      (:649), so reads never extend an entry. A warmer on a 24h cycle against a 24h TTL
#      races its own expiry: run slightly early and every request is a free cache hit.
#      Measured on alpha 2026-10-29 — 21 of 22 taxa returned in 0-1s and the run reported
#      "done in 4 min, 1 failure(s)" while refilling NOTHING. Cached vs cold for the same
#      taxon: 0.16s vs 56.0s. /admin/cache/refresh is only reachable over loopback.
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
TIMEOUT="${TIMEOUT:-3600}"          # per taxon; Viruses measured 32.8 min
PAUSE="${PAUSE:-5}"                 # breathing room between taxa
DRY_RUN="${DRY_RUN:-0}"
UA="${UA:-bvbrc-api/warm-taxa}"

# The admin token comes from p3api.conf by default — the same file the API reads, so
# there is ONE copy of the secret and no way for a crontab and the server to drift apart.
# A token in a crontab is also visible to anyone who can run `ps` while the job starts,
# and ends up in cron mail and shell history; reading the file avoids all three.
#
# Resolution order, first hit wins:
#   $ADMIN_TOKEN        explicit override, for ad-hoc runs
#   $P3_API_CONFIG      same env var config.js:360 honours
#   ./p3api.conf        relative to the repo root, as config.js defaults to
#
# Note config.js resolves './p3api.conf' against the API's CWD, not this script's
# location, so when run from cron the path is derived from the script instead — cron's
# CWD is the invoking user's home and would silently find nothing.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${P3_API_CONFIG:-${REPO_ROOT}/p3api.conf}"

if [ -z "${ADMIN_TOKEN:-}" ] && [ -r "$CONF" ]; then
  # python3 rather than a grep/sed: p3api.conf is JSON, and a regex would be fooled by
  # the token appearing in a comment key or by any reordering. Fails silently to empty,
  # which the check below turns into a clear error.
  ADMIN_TOKEN=$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as fh:
        print((json.load(fh).get("admin") or {}).get("token") or "")
except Exception:
    print("")
' "$CONF" 2>/dev/null)
fi
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

# A real recomputation takes seconds to minutes. A refresh faster than this did not do
# the work we think it did. Reported distinctly, because a run that is fast and green
# while achieving nothing is exactly how this script's previous failure went unnoticed.
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
if [ -z "$ADMIN_TOKEN" ]; then
  echo "### ERROR: no admin token."
  if [ ! -r "$CONF" ]; then
    echo "###   $CONF is missing or unreadable."
  else
    echo "###   $CONF has no admin.token. Add:"
    echo '###       "admin": { "enabled": true, "token": "<a long random string>" }'
  fi
  echo "###   Or pass ADMIN_TOKEN=... for a one-off run. See PLAN_ADMIN_ENDPOINT.md."
  exit 1
fi

FAILED=0
HITS=0
START=$(date +%s)

for t in "${TAXA[@]}"; do
  # One call does the whole refresh: the admin endpoint recomputes with
  # X-Apicache-Bypass and then OVERWRITES the key, so the cached value is never absent
  # and a failed fill leaves the previous one intact. The script no longer fetches the
  # public URL itself -- doing so after a delete is what opened a 33-minute hole.
  refresh_url="${BASE}/admin/cache/refresh/summary_by_taxon/${t}"

  # Informational: when this taxon last ingested a genome. Cheap, and it makes a run log
  # interpretable ("why did that one take 30 minutes").
  newest=$(curl -s -m 60 -H "User-Agent: $UA" \
    "${BASE}/genome/?eq(taxon_lineage_ids,${t})&sort(-date_inserted)&limit(1)&select(date_inserted)&http_accept=application/json" \
    2>/dev/null | sed -n 's/.*"date_inserted":"\([^"]*\)".*/\1/p')

  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] $t  newest_genome=${newest:-unknown}  refresh=${refresh_url}"
    continue
  fi

  t0=$(date +%s)
  body=$(curl -s -m "$TIMEOUT" -X POST -H "User-Agent: $UA" \
    -H "X-Admin-Token: ${ADMIN_TOKEN}" -w '\n%{http_code}' "$refresh_url" 2>/dev/null)
  code=$(printf '%s' "$body" | tail -1)
  el=$(( $(date +%s) - t0 ))

  case "$code" in
    200)
      # The endpoint reports elapsed time itself; a sub-threshold refresh means the
      # recomputation did not actually happen (an unexpectedly cheap taxon, or a
      # misconfiguration), which is worth seeing rather than counting as success.
      if [ "$el" -lt "$HIT_THRESHOLD_S" ]; then
        printf '  %-9s refreshed %3ds  (suspiciously fast -- verify this taxon is costly)\n' "$t" "$el"
        HITS=$((HITS+1))
      else
        printf '  %-9s REFRESHED %3ds  newest=%s\n' "$t" "$el" "${newest:-?}"
      fi
      ;;
    000) printf '  %-9s TIMEOUT after %ds -- raise TIMEOUT or investigate\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    403) printf '  %-9s HTTP 403 (%ds) -- admin gate refused; BASE must be 127.0.0.1 and ADMIN_TOKEN must match\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    404) printf '  %-9s HTTP 404 (%ds) -- is admin.enabled true in p3api.conf?\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    502) printf '  %-9s REFRESH FAILED (%ds) -- upstream error; previous cached value left intact\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    503) printf '  %-9s HTTP 503 (%ds) -- redis not connected\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    524) printf '  %-9s HTTP 524 (%ds) -- Cloudflare cut it; BASE must be loopback\n' "$t" "$el"
         FAILED=$((FAILED+1)) ;;
    *)   printf '  %-9s HTTP %s (%ds)\n' "$t" "$code" "$el"
         FAILED=$((FAILED+1)) ;;
  esac

  sleep "$PAUSE"
done

echo "### done in $(( ($(date +%s) - START) / 60 )) min, ${FAILED} failure(s), ${HITS} suspiciously fast"
if [ "$HITS" -gt 0 ]; then
  echo "### NOTE: ${HITS} taxa refreshed in under ${HIT_THRESHOLD_S}s. Either those taxa are"
  echo "###       genuinely cheap, or the refresh is not recomputing what we expect."
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
