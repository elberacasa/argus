#!/bin/bash

# Does the pool need K sessions x M tabs, or is M tabs in one session enough?
#
# Tabs share a process and cost ~4x less memory, but WebDriver serializes
# commands per session. Whether that serialization actually costs anything
# depends on where the time goes: if a tab switch is single-digit milliseconds
# and a page load is hundreds, agent work is latency-bound on the network and
# the session lock is free. This measures which world we are in before the
# harder design gets built.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT=9515
BASE=http://127.0.0.1:$PORT
URLS=(https://example.com https://example.org https://example.net
      https://www.iana.org/help/example-domains https://example.com
      https://example.org https://example.net https://www.iana.org/domains/reserved)
N=${1:-8}

driver_up() {
  curl -sf --max-time 1 "$BASE/status" >/dev/null 2>&1 && return 0
  setsid chromedriver --port=$PORT --silent >/dev/null 2>&1 </dev/null & disown
  for _ in $(seq 1 60); do curl -sf --max-time 1 "$BASE/status" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
new_session() {
  curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{
    "capabilities":{"alwaysMatch":{"browserName":"chrome","goog:chromeOptions":{
      "binary":"/usr/bin/chromium",
      "args":["--headless=new","--disable-gpu","--disable-dev-shm-usage",
              "--no-first-run","--blink-settings=imagesEnabled=false","--window-size=1280,800"]}}}}' \
    | jq -r '.value.sessionId // empty'
}
kill_all() {
  curl -s "$BASE/sessions" 2>/dev/null | jq -r '.value[]?.id' 2>/dev/null \
    | while read -r s; do curl -s -X DELETE "$BASE/session/$s" >/dev/null; done
  sleep 1
}
rss() { ps -o rss= -C chromium 2>/dev/null | awk '{s+=$1} END {printf "%d", s/1024}'; }
ms()  { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

driver_up || { echo "no chromedriver"; exit 1; }
kill_all

echo "=== A. tab-switch latency (the cost the K x M design exists to avoid) ==="
S=$(new_session)
for _ in $(seq 1 7); do
  curl -s -X POST "$BASE/session/$S/window/new" -H 'Content-Type: application/json' -d '{"type":"tab"}' >/dev/null
done
mapfile -t H < <(curl -s "$BASE/session/$S/window/handles" | jq -r '.value[]')
t0=$(date +%s%N)
for i in $(seq 1 40); do
  curl -s -X POST "$BASE/session/$S/window" -H 'Content-Type: application/json' \
    -d "{\"handle\":\"${H[$(( i % ${#H[@]} ))]}\"}" >/dev/null
done
total=$(ms "$t0")
printf '  40 switches across %d tabs: %dms total, %.1fms each\n' "${#H[@]}" "$total" "$(awk "BEGIN{print $total/40}")"

echo
echo "=== B. throughput: N pages opened + text-extracted ==="

# B1: one session, N tabs, necessarily serialized.
t0=$(date +%s%N)
for i in $(seq 0 $((N-1))); do
  curl -s -X POST "$BASE/session/$S/window" -H 'Content-Type: application/json' \
    -d "{\"handle\":\"${H[$(( i % ${#H[@]} ))]}\"}" >/dev/null
  curl -s -X POST "$BASE/session/$S/url" -H 'Content-Type: application/json' \
    -d "{\"url\":\"${URLS[$i]}\"}" >/dev/null
  curl -s -X POST "$BASE/session/$S/execute/sync" -H 'Content-Type: application/json' \
    -d '{"script":"return document.body.innerText.length","args":[]}' >/dev/null
done
serial=$(ms "$t0"); serial_rss=$(rss)
kill_all

# B2: N sessions, genuinely concurrent.
t0=$(date +%s%N)
for i in $(seq 0 $((N-1))); do
  ( s=$(new_session)
    curl -s -X POST "$BASE/session/$s/url" -H 'Content-Type: application/json' -d "{\"url\":\"${URLS[$i]}\"}" >/dev/null
    curl -s -X POST "$BASE/session/$s/execute/sync" -H 'Content-Type: application/json' \
      -d '{"script":"return document.body.innerText.length","args":[]}' >/dev/null ) &
done
wait
parallel=$(ms "$t0"); parallel_rss=$(rss)
kill_all

# B3: the hybrid -- K sessions, each serving N/K pages in its own tabs.
K=4
t0=$(date +%s%N)
for k in $(seq 0 $((K-1))); do
  ( s=$(new_session)
    per=$(( (N + K - 1) / K ))
    for j in $(seq 0 $((per-1))); do
      idx=$(( k * per + j )); (( idx >= N )) && break
      curl -s -X POST "$BASE/session/$s/url" -H 'Content-Type: application/json' -d "{\"url\":\"${URLS[$idx]}\"}" >/dev/null
      curl -s -X POST "$BASE/session/$s/execute/sync" -H 'Content-Type: application/json' \
        -d '{"script":"return document.body.innerText.length","args":[]}' >/dev/null
    done ) &
done
wait
hybrid=$(ms "$t0"); hybrid_rss=$(rss)
kill_all

printf '\n  %-34s %8s %10s\n' "design" "wall ms" "peak MB"
printf '  %-34s %8d %10d\n' "1 session x $N tabs (serialized)" "$serial"   "$serial_rss"
printf '  %-34s %8d %10d\n' "$N sessions (parallel)"            "$parallel" "$parallel_rss"
printf '  %-34s %8d %10d\n' "$K sessions x $((N/K)) tabs (hybrid)" "$hybrid" "$hybrid_rss"
printf '\n  parallel is %.1fx faster than serial, at %.1fx the memory\n' \
  "$(awk "BEGIN{print $serial/$parallel}")" "$(awk "BEGIN{print $parallel_rss/($serial_rss+1)}")"
printf '  hybrid   is %.1fx faster than serial, at %.1fx the memory\n' \
  "$(awk "BEGIN{print $serial/$hybrid}")" "$(awk "BEGIN{print $hybrid_rss/($serial_rss+1)}")"
