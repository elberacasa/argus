#!/bin/bash

# Drive N lanes doing realistic, *different* work, so `argus watch` has
# something true to show. Some lanes succeed, some hit a blocked control, some
# audit badly -- which is the point: a dashboard where every pane looks the same
# teaches you nothing.
#
#   ./test/demo.sh 12      # in one terminal
#   ./bin/argus-legacy watch      # in another

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
N=${1:-12}
FIXTURE="file://$PWD/test/fixture.html"
A=./bin/argus-legacy

SITES=(
  "https://example.com" "https://example.org" "https://example.net"
  "https://www.iana.org/help/example-domains" "https://www.iana.org/domains/reserved"
)

# A lane that opens a page, looks around, and reports on it.
browse_lane() {
  local lane=$1 site=${SITES[$(( RANDOM % ${#SITES[@]} ))]}
  $A --lane "$lane" open "$site"  >/dev/null 2>&1
  $A --lane "$lane" audit         >/dev/null 2>&1
  $A --lane "$lane" click "link:Example Domains" >/dev/null 2>&1   # often absent: a real not-found
  $A --lane "$lane" audit         >/dev/null 2>&1
}

# A lane that works the checkout fixture, including the blocked-click recovery.
checkout_lane() {
  local lane=$1
  $A --lane "$lane" open "$FIXTURE"                                >/dev/null 2>&1
  $A --lane "$lane" click "button:Place order"                     >/dev/null 2>&1   # covered
  $A --lane "$lane" click "button:Pay later"                       >/dev/null 2>&1   # disabled
  $A --lane "$lane" audit                                          >/dev/null 2>&1
  $A --lane "$lane" click "button:Accept"                          >/dev/null 2>&1   # dismiss
  $A --lane "$lane" type  "textbox:Email address" "a@example.com"   >/dev/null 2>&1
  $A --lane "$lane" click "button:Place order"                     >/dev/null 2>&1   # succeeds
}

printf 'driving %d lanes...\n' "$N"
for (( i = 0; i < N; i++ )); do
  if (( i % 3 == 1 )); then checkout_lane "$i" & else browse_lane "$i" & fi
done
wait
printf 'done. %s\n' "$($A pool | tail -1)"
