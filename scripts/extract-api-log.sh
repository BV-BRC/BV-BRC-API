#!/bin/bash
#
# Extract data API log entries for a given time range.
#
# Usage:
#   ./extract-api-log.sh <logfile> <start> <end> [output]
#
# Arguments:
#   logfile  - Path to the data API log file
#   start    - Start time in ISO format, e.g. "2026-06-02T17:00:00"
#   end      - End time in ISO format, e.g. "2026-06-02T19:15:00"
#   output   - Optional output file (default: stdout)
#
# Examples:
#   ./extract-api-log.sh /var/log/p3api/app.log "2026-06-02T17:00:00" "2026-06-02T19:15:00"
#   ./extract-api-log.sh /var/log/p3api/app.log "2026-06-02T17:00:00" "2026-06-02T19:15:00" extracted.log
#
# Notes:
#   - Timestamps in the log are UTC (trailing Z)
#   - Lines without timestamps (e.g. [Limiter] lines) are included if they
#     fall between two timestamped lines within the range
#   - Uses awk for single-pass processing, works on large files

if [ $# -lt 3 ]; then
    echo "Usage: $0 <logfile> <start> <end> [output]" >&2
    echo "  Times are ISO format, e.g. 2026-06-02T17:00:00" >&2
    echo "  Log timestamps are UTC" >&2
    exit 1
fi

LOGFILE="$1"
START="$2"
END="$3"
OUTPUT="$4"

if [ ! -f "$LOGFILE" ]; then
    echo "Error: File not found: $LOGFILE" >&2
    exit 1
fi

extract() {
    awk -v start="$START" -v end="$END" '
    {
        # Try to extract timestamp from lines like [2026-06-02T20:21:05.022Z]
        if (match($0, /\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]+Z\]/, m)) {
            ts = m[1]
            if (ts >= start && ts <= end) {
                in_range = 1
            } else if (ts > end) {
                in_range = 0
            } else {
                in_range = 0
            }
        }
        # Lines without timestamps (e.g. [Limiter]) are included if we are in range
        if (in_range) print
    }' "$LOGFILE"
}

if [ -n "$OUTPUT" ]; then
    extract > "$OUTPUT"
    lines=$(wc -l < "$OUTPUT")
    echo "Extracted $lines lines to $OUTPUT" >&2
else
    extract
fi
