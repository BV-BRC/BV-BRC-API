#!/bin/bash
#
# Analyze API traffic from frontend proxy logs.
#
# Produces a Slack-pastable summary of traffic patterns: top sources,
# endpoints, user agents, data volume, and notable scrapers.
#
# Usage:
#   ./analyze-api-traffic.sh <logfile> [logfile2 ...]
#   ./analyze-api-traffic.sh -                          # read from stdin
#
# Multiple log files (e.g., from two proxy hosts) are merged automatically.
#
# Log format expected (nginx combined + extras):
#   IP - - [date] "METHOD URL HTTP/x.x" status size "referer" "user-agent" timestamp response_time host rid=...
#
# Examples:
#   ./analyze-api-traffic.sh /var/log/nginx/api-access.log
#   ./analyze-api-traffic.sh proxy1-access.log proxy2-access.log
#   zcat proxy1.log.gz proxy2.log.gz | ./analyze-api-traffic.sh -

set -euo pipefail

if [ $# -eq 0 ] || [ "$1" = "-" ]; then
    TMPFILE=$(mktemp)
    cat > "$TMPFILE"
    LOGFILE="$TMPFILE"
    trap "rm -f $TMPFILE" EXIT
elif [ $# -eq 1 ]; then
    if [ ! -f "$1" ]; then
        echo "Error: File not found: $1" >&2
        exit 1
    fi
    LOGFILE="$1"
else
    # Multiple files — merge into a temp file sorted by timestamp
    TMPFILE=$(mktemp)
    trap "rm -f $TMPFILE" EXIT
    for f in "$@"; do
        if [ ! -f "$f" ]; then
            echo "Error: File not found: $f" >&2
            exit 1
        fi
    done
    # Extract epoch timestamp and use it as sort key
    # The epoch is the first number matching \d{10}\.\d+ after the user-agent
    cat "$@" | awk '{
        for(i=1;i<=NF;i++) if($i ~ /^[0-9]{10}\./) {printf "%s\t%s\n",$i,$0; break}
    }' | sort -n -t'	' -k1,1 | cut -f2- > "$TMPFILE"
    LOGFILE="$TMPFILE"
    echo "(Merged $# log files)"
fi

# Portable number formatting (works on macOS and Linux)
fmtnum() {
    printf "%d\n" "$1" | awk '{
        n = $1
        if (n < 0) { neg = "-"; n = -n } else neg = ""
        s = sprintf("%d", n)
        len = length(s)
        result = ""
        for (i = len; i >= 1; i--) {
            result = substr(s, i, 1) result
            if (i > 1 && (len - i + 1) % 3 == 0) result = "," result
        }
        print neg result
    }'
}

TOTAL=$(wc -l < "$LOGFILE" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
    echo "Empty log file"
    exit 0
fi

TIME_START=$(head -1 "$LOGFILE" | sed -n 's/.*\[\([^]]*\)\].*/\1/p')
TIME_END=$(tail -1 "$LOGFILE" | sed -n 's/.*\[\([^]]*\)\].*/\1/p')

# Calculate duration using epoch timestamps from the log (field matching \d{10}\.)
START_EPOCH=$(head -1 "$LOGFILE" | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]{10}\./) {printf "%d",$i; break}}')
END_EPOCH=$(tail -1 "$LOGFILE" | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]{10}\./) {printf "%d",$i; break}}')
if [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ] && [ "$START_EPOCH" -gt 0 ] && [ "$END_EPOCH" -gt 0 ]; then
    DURATION_HOURS=$(( (END_EPOCH - START_EPOCH) / 3600 ))
else
    DURATION_HOURS="?"
fi

echo "Traffic Report — ${TIME_START%% *} to ${TIME_END%% *} (~${DURATION_HOURS} hours)"
echo "================================================================"
echo ""
echo "Total requests: $(fmtnum $TOTAL)"
echo ""

# --- Status codes ---
echo "Status codes:"
awk '{print $9}' "$LOGFILE" | sort | uniq -c | sort -rn | while read count code; do
    printf "  %s: %s\n" "$code" "$(fmtnum $count)"
done
echo ""

# --- Top endpoints ---
echo "Top endpoints:"
awk -F'"' '{print $2}' "$LOGFILE" | awk '{print $2}' | sed 's/?.*//' | sort | uniq -c | sort -rn | head -15 | while read count endpoint; do
    pct=$(( count * 100 / TOTAL ))
    printf "  %7s (%2d%%)  %s\n" "$(fmtnum $count)" "$pct" "$endpoint"
done
echo ""

# --- Top sources ---
echo "Top sources (by request count):"
awk '{print $1}' "$LOGFILE" | sort | uniq -c | sort -rn | head -15 | while read count ip; do
    pct=$(( count * 100 / TOTAL ))
    # Get user agent and top endpoint for this IP
    agent=$(grep "^$ip " "$LOGFILE" | head -1 | awk -F'"' '{print $6}' | cut -c1-40)
    endpoint=$(grep "^$ip " "$LOGFILE" | awk -F'"' '{print $2}' | awk '{print $2}' | sed 's/?.*//' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')
    # Data volume
    vol=$(grep "^$ip " "$LOGFILE" | awk '{s+=$10}END{
        if(s>1073741824) printf "%.1fGB",s/1073741824;
        else if(s>1048576) printf "%.0fMB",s/1048576;
        else printf "%.0fKB",s/1024
    }')
    printf "  %7s (%2d%%)  %-18s  %8s  %-30s  %s\n" \
        "$(fmtnum $count)" \
        "$pct" "$ip" "$vol" "$agent" "$endpoint"
done
echo ""

# --- User agents ---
echo "User agents:"
awk -F'"' '{print $6}' "$LOGFILE" | sort | uniq -c | sort -rn | head -10 | while read count ua; do
    pct=$(( count * 100 / TOTAL ))
    printf "  %7s (%2d%%)  %s\n" "$(fmtnum $count)" "$pct" "$ua"
done
echo ""

# --- Automated/scraper detection ---
echo "Automated traffic (non-browser user agents):"
awk -F'"' '{print $1 "|||" $6}' "$LOGFILE" | grep -viE 'Mozilla|Opera|Safari' | awk -F'|||' '{print $1}' | awk '{print $1}' | sort -u | while read ip; do
    count=$(grep -c "^$ip " "$LOGFILE")
    if [ "$count" -lt 100 ]; then
        continue
    fi
    agent=$(grep "^$ip " "$LOGFILE" | head -1 | awk -F'"' '{print $6}' | cut -c1-50)

    # Response time stats
    times=$(grep "^$ip " "$LOGFILE" | awk '{print $(NF-2)}' | sort -n)
    median=$(echo "$times" | awk 'NR==int(NR/2){print}')
    p95=$(echo "$times" | awk -v n="$(echo "$times" | wc -l)" 'NR==int(n*0.95){print}')

    # Data volume
    vol=$(grep "^$ip " "$LOGFILE" | awk '{s+=$10}END{
        if(s>1073741824) printf "%.1fGB",s/1073741824;
        else if(s>1048576) printf "%.0fMB",s/1048576;
        else printf "%.0fKB",s/1024
    }')

    # Unique genomes
    genomes=$(grep "^$ip " "$LOGFILE" | grep -oE 'genome_id[,=][0-9]+\.[0-9]+' | sort -u | wc -l | tr -d ' ')

    # Top endpoints
    top_ep=$(grep "^$ip " "$LOGFILE" | awk -F'"' '{print $2}' | awk '{print $2}' | sed 's/?.*//' | sort | uniq -c | sort -rn | head -3 | awk '{printf "%s(%s) ",$2,$1}')

    # Errors
    errors=$(grep "^$ip " "$LOGFILE" | awk '$9>=400{n++}END{print n+0}')

    printf "\n  %s — %s requests, %s transferred\n" "$ip" "$(fmtnum $count)" "$vol"
    printf "    Agent: %s\n" "$agent"
    printf "    Response time: median %ss, p95 %ss\n" "${median:-?}" "${p95:-?}"
    [ "$genomes" -gt 0 ] && printf "    Unique genomes: %s\n" "$(fmtnum $genomes)"
    [ "$errors" -gt 0 ] && printf "    Errors: %s\n" "$errors"
    printf "    Endpoints: %s\n" "$top_ep"
done
echo ""

# --- Hourly request rate ---
echo "Hourly request rate:"
awk '{print $4}' "$LOGFILE" | sed 's/\[//;s/:/ /;s/\// /g' | awk '{printf "%s %s %s:00\n",$1,$2,$3}' | sort | uniq -c | awk '{printf "  %s %s %s  %s requests\n",$2,$3,$4,$1}'
echo ""

# --- Data volume summary ---
echo "Data volume summary:"
awk '{s+=$10; n++}END{
    printf "  Total transferred: %.1f GB\n", s/1073741824
    printf "  Avg response size: %.0f KB\n", s/n/1024
}' "$LOGFILE"

# Error summary
ERRORS=$(awk '$9>=400' "$LOGFILE" | wc -l | tr -d ' ')
if [ "$ERRORS" -gt 0 ]; then
    echo ""
    echo "Errors ($ERRORS total):"
    awk '$9>=400{print $9}' "$LOGFILE" | sort | uniq -c | sort -rn | while read count code; do
        printf "  %s: %s\n" "$code" "$count"
    done
    echo ""
    echo "Top error sources:"
    awk '$9>=400{print $1}' "$LOGFILE" | sort | uniq -c | sort -rn | head -5 | while read count ip; do
        printf "  %s: %s errors\n" "$ip" "$count"
    done
fi

# --- Internal amplification ---
INTERNAL=$(grep '140.221.39.6' "$LOGFILE" 2>/dev/null | grep -c 'feature_sequence' || echo 0)
EXTERNAL=$(grep -vc '140.221.39.6' "$LOGFILE" 2>/dev/null || echo 0)
if [ "$INTERNAL" -gt 1000 ]; then
    echo ""
    echo "Internal amplification:"
    printf "  feature_sequence calls (from API server): %s\n" "$(fmtnum $INTERNAL)"
    printf "  External requests: %s\n" "$(fmtnum $EXTERNAL)"
    if [ "$EXTERNAL" -gt 0 ]; then
        ratio=$(( INTERNAL / EXTERNAL ))
        printf "  Amplification ratio: %s:1\n" "$ratio"
    fi
fi
