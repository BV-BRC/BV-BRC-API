#!/bin/bash
#
# Reproduce the GenBank multi-genome download stall with curl + pv.
# (Public genomes — no auth token required.)
#
# Usage:
#   scripts/repro-genbank-stall.sh <base_url> [rate] [rql]
#
#   base_url  API base, e.g. https://onprem-host/api  or  http://localhost:13001
#   rate      curl --limit-rate value to SIMULATE A SLOW CLIENT (e.g. 200k, 1m).
#             This is the important knob: the stall is triggered by the client
#             draining slower than the server generates. Throttling curl
#             reproduces that even when curl runs ON-PREM over a fast link.
#             Pass "0" or omit to download full speed (won't reproduce the stall
#             on a fast/local connection).
#   rql       Override the query. Defaults to the 200-genome set from hang2.log.
#
# Examples:
#   # On-prem, through the proxy, throttled to mimic an offsite browser:
#   scripts/repro-genbank-stall.sh https://onprem-host/api 200k
#
#   # Full speed (baseline / fast link):
#   scripts/repro-genbank-stall.sh http://localhost:13001 0
#
# pv shows a live throughput line: elapsed, bytes, instantaneous + average rate.
# A STALL is obvious — the rate drops to 0 while elapsed keeps climbing.
#
# What the throttled run tells you:
#   - Completes smoothly at ~rate  -> backpressure works, no stall. Fixed.
#   - Freezes at 0 B/s then resumes ~60s later -> proxy read-timeout firing
#     between slow writes (nginx proxy_read_timeout). Matches Chrome "resuming".
#   - Freezes at 0 B/s and dies (curl exit 18/56) -> connection dropped mid-stream.

set -u

BASE_URL="${1:?need base_url, e.g. https://onprem-host/api}"
RATE="${2:-0}"
RQL="${3:-in(genome_id,(470.36610,470.36611,470.36616,470.36618,470.36621,470.36635,470.36636,470.36637,470.36638,470.36639,470.36646,470.36647,470.36651,470.36652,470.36663,470.36665,470.36666,470.36667,470.36668,470.36669,470.36671,470.36672,470.36673,470.36674,470.36675,470.36676,470.36677,470.36678,470.36679,470.36680,470.36681,470.36682,470.36683,470.36684,470.36685,470.36686,470.36687,470.36688,470.36689,470.36690,470.36691,470.36692,470.36693,470.36694,470.36695,470.36696,470.36697,470.36698,470.36699,470.36700,470.36701,470.36702,470.36703,470.36704,470.36705,470.36706,470.36707,470.36708,470.36709,470.36710,470.36711,470.36712,470.36713,470.36714))&limit(2500000)}"

OUT="/tmp/genbank-repro-$$.gbk"
# GenBank downloads must target the genome collection (feature-level collections
# are rejected by a guard and would stream millions of docs to recover the
# genome_id list). The serializer fetches contigs/features per genome itself.
URL="${BASE_URL}/genome/?http_download=true&http_accept=application/genbank"
ENC_RQL=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$RQL")

RATE_ARG=()
if [ "$RATE" != "0" ] && [ -n "$RATE" ]; then
  RATE_ARG=(--limit-rate "$RATE")
  echo "RATE:  $RATE (simulated slow client)"
else
  echo "RATE:  unthrottled (won't reproduce the stall on a fast link)"
fi

echo "URL:   $URL"
echo "OUT:   $OUT"
echo "RQL:   ${RQL:0:80}..."
echo "Watch the pv line — a stall shows as [ 0 B/s] while the timer keeps going."
echo

# Interval (seconds) between pv status samples. Override: PV_INTERVAL=5 ...
PV_INTERVAL="${PV_INTERVAL:-10}"

# Meter: pv rewrites its status line in place every PV_INTERVAL seconds using a
# carriage return. Piping pv's stderr through `tr '\r' '\n'` turns each in-place
# update into a NEW scrolling line, so you get a timestamped history of how the
# rate evolves over time instead of a single overwriting line.
#   -b bytes  -t timer  -r recent rate (last window)  -a average rate (whole xfer)
#   -f force meter even when stderr isn't a terminal (needed inside the pipe)
# Watching both rates: `recent` dropping to 0 = a live stall; `average` low while
# `recent` is healthy just means a slow start is still being averaged in.
run_meter () {
  if command -v pv >/dev/null; then
    pv -bratf -i "$PV_INTERVAL" 2> >(tr '\r' '\n' >&2)
  else
    echo "(pv not found — falling back to cat; install pv for the live meter)" >&2
    cat
  fi
}

# -N/--no-buffer: hand bytes to the pipe as they arrive (don't buffer the body)
# -sS: quiet but show errors
# Accept-Encoding: identity — no gzip, so pv byte counts map to real payload and
#   the proxy can't buffer a compression window.
# curl's -w summary goes to stderr via a second fd so it survives the pipe.
curl -sS -N ${RATE_ARG[@]+"${RATE_ARG[@]}"} \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept-Encoding: identity' \
  --data-raw "rql=${ENC_RQL}" \
  -w '%{stderr}CURLSUMMARY http_code=%{http_code} http_ver=%{http_version} ttfb=%{time_starttransfer}s total=%{time_total}s size=%{size_download} speed=%{speed_download}B/s connects=%{num_connects} errormsg=%{errormsg}\n' \
  "$URL" \
  2> >(grep CURLSUMMARY >&2) \
  | run_meter > "$OUT"
CURL_EXIT=${PIPESTATUS[0]}

echo
echo "curl exit: $CURL_EXIT  (0=ok, 18=partial/transfer closed, 28=timeout, 56=recv error)"
echo "LOCUS records written: $(grep -c '^LOCUS' "$OUT" 2>/dev/null || echo 0)"
echo "last genome in file:   $(grep '^LOCUS' "$OUT" 2>/dev/null | tail -1 | awk '{print $2}')"
# A complete GenBank stream ends each record with a // terminator line; the very
# last line of a fully-delivered file is '//'. If it is not, the stream was
# truncated mid-record (partial transfer).
LAST_LINE="$(tail -1 "$OUT" 2>/dev/null)"
if [ "$LAST_LINE" = "//" ]; then
  echo "completeness: OK (file ends with //)"
else
  echo "completeness: TRUNCATED (last line: '${LAST_LINE:0:60}')"
fi
echo "output kept at: $OUT"
