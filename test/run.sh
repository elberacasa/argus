#!/bin/bash

# argus test suite.
#
# Every assertion runs against test/fixture.html, which plants one instance of
# each defect argus claims to detect. If a check here stops passing, argus is
# lying to an agent somewhere -- which is worse than having no check at all.

cd "$(dirname "$0")/.." || exit 1
ARGUS=./bin/argus-legacy
ROOTDIR=$PWD
FIXTURE="file://$PWD/test/fixture.html"
export ARGUS_LANE=${ARGUS_LANE:-9}

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n'   "$1"; printf '       got: %s\n' "${2:0:200}"; fail=$((fail+1)); }
# Asserts that a jq filter over the command's JSON output matches `want`.
check() { # <name> <want> <jq-filter> <argus args...>
  local name=$1 want=$2 filter=$3; shift 3
  local out got
  out=$("$ARGUS" --json "$@" 2>/dev/null)
  got=$(jq -r "$filter" <<<"$out" 2>/dev/null)
  [[ $got == "$want" ]] && ok "$name" || bad "$name (wanted '$want')" "${got:-$out}"
}

reset() { "$ARGUS" --json open "$FIXTURE" >/dev/null 2>&1; }
dismiss() { "$ARGUS" --json click "button:Accept" >/dev/null 2>&1; }

printf '\033[1margus test suite\033[0m  lane %s\n\n' "$ARGUS_LANE"

printf '\033[2mstatic\033[0m\n'
# Runs first and needs no browser: a class of bash bug that renders plausibly
# and works only when a caller happens to share a variable name.
if lint=$(python3 test/lint-locals.py 2>&1); then
  ok "no local reads a name it is declaring"
else
  bad "no local reads a name it is declaring" "$lint"
fi
for f in bin/argus bin/argus-legacy bin/argus-watch bin/argus-mcp bin/argus-mcp-legacy bin/argus-manifest bin/argus-own bin/argus-bar bin/argus-nest lib/*.sh test/*.sh; do
  bash -n "$f" 2>/dev/null || bad "bash -n $f" "$(bash -n "$f" 2>&1)"
done
ok "every script parses"
for f in lib/probe.js lib/locate.js lib/audit.js; do
  node -e "new Function(require('fs').readFileSync('$f','utf8'))" 2>/dev/null || bad "$f parses" "syntax error"
done
ok "every injected script parses as a WebDriver function body"
printf '\n'

printf '\033[2mdelta engine\033[0m\n'
reset
check "page load reports rendered text"  true    '.delta.added|length>3'                 open "$FIXTURE"
check "parse-time console error is seen" true    '[.delta.console[].text]|any(test("tracking id"))' open "$FIXTURE"
check "settle reports a real reason"     true    '.settled.reason|test("network-idle")'   open "$FIXTURE"

printf '\n\033[2mlocator diagnosis\033[0m\n'
reset
check "covered element names its blocker" covered   '.diagnosis.reason'    click "button:Place order"
check "blocker is identified"             div#scrim '.diagnosis.coveredBy' click "button:Place order"
check "disabled control is diagnosed"     disabled  '.diagnosis.reason'    click "button:Pay later"
check "unknown name suggests alternatives" true     '.diagnosis.didYouMean|length>0' click "button:Place ordr"
check "ambiguity refuses to guess"        ambiguous '.diagnosis.reason'    click "button:Remove"
check "ambiguity lists candidates"        2         '.diagnosis.candidates|length' click "button:Remove"

printf '\n\033[2mactions\033[0m\n'
reset; dismiss
check "click produces a causal text delta" true '[.delta.added[]]|any(test("Order placed"))' click "button:Place order"
reset; dismiss
check "click reports the failed request"   true '[.delta.network[].url]|any(test("receipt"))' click "button:Place order"
reset; dismiss
check "typing is observed as a field change" "agent@example.com" '.delta.fields[0].to' type "textbox:Email address" "agent@example.com"
reset; dismiss
check "index disambiguates"                 true '.action=="click"' click "button:Remove" 1

printf '\n\033[2maudit\033[0m\n'
reset
A=$("$ARGUS" --json audit 2>/dev/null)
for rule in contrast tap-target overflow-x unnamed-control heading-order tiny-text; do
  if jq -e --arg r "$rule" '[.findings[].rule]|index($r)' <<<"$A" >/dev/null 2>&1; then
    ok "detects $rule"
  else bad "detects $rule" "$(jq -c '[.findings[].rule]' <<<"$A")"; fi
done
got=$(jq -r '[.findings[]|select(.rule=="contrast")|.examples[]|select(.at=="p.muted")|.contrast][0]' <<<"$A")
awk "BEGIN{exit !($got > 2.0 && $got < 2.2)}" && ok "contrast is computed accurately ($got:1)" \
  || bad "contrast is computed accurately" "$got"
[[ $(jq -r '.score' <<<"$A") -lt 70 ]] && ok "a defective page scores poorly" || bad "a defective page scores poorly" "$(jq -r .score <<<"$A")"

printf '\n\033[2mtrace\033[0m\n'
reset; dismiss
"$ARGUS" click "button:Place order" >/dev/null 2>&1
T=$("$ARGUS" --json trace -n 50 2>/dev/null)
[[ -n $T ]] && ok "actions are recorded" || bad "actions are recorded" "empty"
jq -se 'map(select(.action=="open"))|length>0' <<<"$T" >/dev/null \
  && ok "trace keeps the navigation" || bad "trace keeps the navigation" "$(jq -sc '[.[].action]' <<<"$T")"
jq -se 'map(select(.ok==false))|length>0' <<<"$T" >/dev/null \
  && ok "trace keeps failures with their diagnosis" || bad "trace keeps failures" "$(jq -sc '[.[].ok]' <<<"$T")"
jq -se 'all(.[]; has("t") and has("lane"))' <<<"$T" >/dev/null \
  && ok "every record is timestamped and laned" || bad "records carry t and lane" "$(jq -sc '.[0]' <<<"$T")"
"$ARGUS" --no-trace click "button:Save" >/dev/null 2>&1
n1=$("$ARGUS" --json trace -n 500 2>/dev/null | wc -l)
"$ARGUS" --no-trace click "button:Save" >/dev/null 2>&1
n2=$("$ARGUS" --json trace -n 500 2>/dev/null | wc -l)
[[ $n1 -eq $n2 ]] && ok "--no-trace writes nothing" || bad "--no-trace writes nothing" "$n1 -> $n2"

# jq's strftime is UTC while date(1) is local, so a trace can silently disagree
# with its own header by the timezone offset -- which makes correlating against
# any other log quietly wrong.
reset
[[ $("$ARGUS" trace -n 1 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | awk '{print $1}' | cut -d: -f1) == "$(date +%H)" ]] \
  && ok "trace timestamps are local, not UTC" \
  || bad "trace timestamps are local" "$("$ARGUS" trace -n 1 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | head -c 40) vs $(date +%H)"

printf '\n\033[2mdashboard\033[0m\n'
W=$(COLUMNS=150 LINES=40 ./bin/argus-watch --once 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g; s/\[2K//')
grep -q "lane $ARGUS_LANE" <<<"$W" && ok "watch renders the active lane" || bad "watch renders the active lane" "$W"
grep -q "audit" <<<"$W" && ok "watch shows an audit score" || bad "watch shows an audit score" "$W"
bar_line=$(grep -m1 '[█░]' <<<"$W")
[[ -n $bar_line ]] && ok "score bar renders" || bad "score bar renders" "$W"
# Unit-test the arithmetic rather than whichever lane happens to render first:
# a 100/100 lane is legitimately all-filled, so the frame cannot prove the math.
# `local a=$1 b=$2 c=$((a*b))` silently yields zero, and that is what this catches.
source <(sed -n '/^bar()/,/^}/p' bin/argus-watch)
[[ $(bar 0 10)   == "░░░░░░░░░░" ]] && ok "bar: 0 is empty"   || bad "bar: 0 is empty"   "$(bar 0 10)"
[[ $(bar 100 10) == "██████████" ]] && ok "bar: 100 is full"  || bad "bar: 100 is full"  "$(bar 100 10)"
[[ $(bar 50 10)  == "█████░░░░░" ]] && ok "bar: 50 is half"   || bad "bar: 50 is half"   "$(bar 50 10)"

printf '\n\033[2mpool\033[0m\n'
STATE=${XDG_RUNTIME_DIR:-/tmp}/argus
sid_of() { cut -f1 "$STATE/lane-$1" 2>/dev/null; }
tab_of() { cut -f2 "$STATE/lane-$1" 2>/dev/null; }
for l in 20 24 21; do "$ARGUS" --lane $l open "$FIXTURE" >/dev/null 2>&1; done
# 20 and 24 both land on slot 0 with pool size 4; 21 lands on slot 1.
[[ -n $(sid_of 20) && $(sid_of 20) == "$(sid_of 24)" ]] \
  && ok "lanes on one slot share a browser" || bad "lanes share a browser" "$(sid_of 20) vs $(sid_of 24)"
[[ $(tab_of 20) != "$(tab_of 24)" ]] \
  && ok "shared lanes still get their own tab" || bad "shared lanes get own tab" "$(tab_of 20)"
[[ $(sid_of 20) != "$(sid_of 21)" ]] \
  && ok "lanes on different slots use different browsers" || bad "different slots differ" "$(sid_of 21)"
# Closing one lane must not take its sibling's tab down with it.
"$ARGUS" --lane 24 close >/dev/null 2>&1
[[ ! -f $STATE/lane-24 ]] && ok "close releases the lane" || bad "close releases the lane" "still mapped"
out=$("$ARGUS" --lane 20 open "$FIXTURE" 2>&1)
[[ $(sid_of 20) != "" ]] && ok "sibling lane survives a close" || bad "sibling survives" "$out"
"$ARGUS" pool 2>/dev/null | grep -q 'pool size' && ok "pool reports its state" || bad "pool reports its state" ""
for l in 20 21; do "$ARGUS" --lane $l close >/dev/null 2>&1; done

printf '\n\033[2mmcp surface (legacy bash server)\033[0m\n'
mcp() { ./bin/argus-mcp-legacy 2>/dev/null; }
MCPOUT=$({
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"omarchy_groups","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"omarchy_run","arguments":{"command":"omarchy-pkg-remove","args":["firefox"]}}}'
  jq -nc --arg f "$FIXTURE" '{jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"browser_open",arguments:{url:$f,lane:31}}}'
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"browser_click","arguments":{"target":"button:Place order","lane":31}}}'
  echo '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"browser_close","arguments":{"lane":31}}}'
} | mcp)
pick() { jq -r --argjson i "$1" 'select(.id==$i)|.result.content[0].text' <<<"$MCPOUT"; }

[[ $(jq -r 'select(.id==1)|.result.serverInfo.name' <<<"$MCPOUT") == argus ]] \
  && ok "initialize handshake" || bad "initialize handshake" "$MCPOUT"
ntools=$(jq -r 'select(.id==2)|.result.tools|length' <<<"$MCPOUT")
[[ $ntools -ge 12 ]] && ok "both surfaces are exposed ($ntools tools)" || bad "tool count" "$ntools"
# The whole point of progressive disclosure: the OS index must stay tiny.
gsize=$(pick 3 | wc -c)
[[ $gsize -lt 1200 ]] && ok "OS index stays under 300 tokens (~$((gsize/4)))" || bad "OS index size" "$gsize chars"
jq -r 'select(.id==4)|.result.isError' <<<"$MCPOUT" | grep -q true \
  && ok "destructive command refused without confirm" || bad "destructive refused" "$(pick 4)"
jq -e '.delta.added|length>0' <<<"$(pick 5)" >/dev/null \
  && ok "browser_open returns a delta" || bad "browser_open delta" "$(pick 5)"
# A diagnosis is a result the agent must read, not a transport error.
[[ $(jq -r '.diagnosis.reason' <<<"$(pick 6)") == covered ]] \
  && ok "a diagnosis arrives as a result, not an error" || bad "diagnosis as result" "$(pick 6)"
jq -r 'select(.id==6)|.result.isError // false' <<<"$MCPOUT" | grep -q false \
  && ok "diagnosis is not flagged isError" || bad "diagnosis not isError" "$(jq -c 'select(.id==6)|.result' <<<"$MCPOUT")"

printf '\n\033[2mdialogs\033[0m\n'
DLG="file://$PWD/test/dialogs.html"
TMPF=$(mktemp -d)
printf 'fake png' > "$TMPF/avatar.png"; printf 'a,b' > "$TMPF/q3.csv"; printf 'n' > "$TMPF/notes.txt"
dopen() { "$ARGUS" --json open "$DLG" >/dev/null 2>&1; }

dopen
R=$("$ARGUS" --json click "button:Delete account" 2>/dev/null)
[[ $(jq -r '.delta.dialogs[0].type + ":" + .delta.dialogs[0].answer' <<<"$R") == "confirm:dismissed" ]] \
  && ok "an unanswered confirm is dismissed and reported, not silent" || bad "confirm reported" "$R"
jq -e '.settled.reason | test("network-idle")' <<<"$R" >/dev/null \
  && ok "a dialog no longer breaks settle detection" || bad "settle survives a dialog" "$(jq -c .settled <<<"$R")"
"$ARGUS" dialog accept >/dev/null 2>&1
R=$("$ARGUS" --json click "button:Delete account" 2>/dev/null)
jq -e '[.delta.added[]]|any(test("Account deleted"))' <<<"$R" >/dev/null \
  && ok "dialog accept answers the next confirm" || bad "dialog accept" "$R"
R=$("$ARGUS" --json click "button:Delete account" 2>/dev/null)
[[ $(jq -r '.delta.dialogs[0].answer' <<<"$R") == dismissed ]] \
  && ok "an accept is one-shot and cannot leak into a later dialog" || bad "accept is one-shot" "$R"
# The bug this pins: an alert used to consume a pending accept meant for a confirm.
dopen; "$ARGUS" dialog accept >/dev/null 2>&1
"$ARGUS" --json click "button:Show notice" >/dev/null 2>&1
R=$("$ARGUS" --json click "button:Delete account" 2>/dev/null)
[[ $(jq -r '.delta.dialogs[0].answer' <<<"$R") == accepted ]] \
  && ok "an alert does not consume an accept meant for a confirm" || bad "alert consumed the accept" "$R"
dopen; "$ARGUS" dialog accept "Q3 Planning" >/dev/null 2>&1
R=$("$ARGUS" --json click "button:Rename workspace" 2>/dev/null)
jq -e '[.delta.added[]]|any(test("Renamed to Q3 Planning"))' <<<"$R" >/dev/null \
  && ok "a prompt receives the supplied text" || bad "prompt text" "$R"
R=$("$ARGUS" --json click "button:Print invoice" 2>/dev/null)
[[ $(jq -r '.delta.dialogs[0].type' <<<"$R") == print ]] && ok "print is suppressed and reported" || bad "print suppressed" "$R"

printf '\n\033[2mfiles\033[0m\n'
dopen
R=$("$ARGUS" --json click "label:Upload avatar" 2>/dev/null)
jq -e '.delta.dialogs[0] | .type=="file-chooser" and .at=="input#avatar"' <<<"$R" >/dev/null \
  && ok "clicking an upload label suppresses the picker and names the input" || bad "picker suppressed" "$R"
R=$("$ARGUS" --json upload "Upload avatar" "$TMPF/avatar.png" 2>/dev/null)
jq -e '[.delta.added[]]|any(test("avatar.png"))' <<<"$R" >/dev/null \
  && ok "upload reaches a hidden input by the label a person reads" || bad "upload by label" "$R"
# The bug this pins: `ok:true` while the input held nothing. Read the page, not the record.
check_page=$(ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "return document.getElementById(\"avatar\").files.length"')
[[ $check_page == 1 ]] && ok "the file is really on the input, verified in the page" || bad "file on input" "$check_page"
R=$("$ARGUS" --json upload "Attachments" "$TMPF/q3.csv" "$TMPF/notes.txt" 2>/dev/null)
jq -e '.delta.fields[0].to | test("q3.csv") and test("notes.txt")' <<<"$R" >/dev/null \
  && ok "multiple files, reported by name" || bad "multiple upload" "$R"
R=$("$ARGUS" --json upload "$TMPF/notes.txt" 2>/dev/null)
[[ $(jq -r '.diagnosis.reason' <<<"$R") == ambiguous ]] && ok "an unnamed upload on a page with two inputs refuses to guess" || bad "upload ambiguity" "$R"
"$ARGUS" upload "Upload avatar" "$TMPF/q3.csv" "$TMPF/notes.txt" >/dev/null 2>&1 \
  && bad "a single-file input rejects two files" "accepted" || ok "a single-file input rejects two files"
R=$("$ARGUS" --json click "link:Export CSV" 2>/dev/null)
dl=$(jq -r '.delta.downloads[0].path // empty' <<<"$R")
[[ -n $dl && -f $dl && $(cat "$dl") == $'id,name\n1,alejo' ]] \
  && ok "a download lands in the lane's directory, not ~/Downloads, with its contents" || bad "download landed" "$R"

printf '\n\033[2mtransport honesty\033[0m\n'
# js() once coerced any all-digit argument to a JS number, which cannot hold 19 digits.
big=1789576055846346799
seen=$(ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; printf "return String(arguments[0])" > /tmp/argus-echo-$$.js; cp /tmp/argus-echo-$$.js lib/.echo.js; js .echo.js '"$big"' | jq -r .; rm -f lib/.echo.js /tmp/argus-echo-$$.js')
[[ $seen == "$big" ]] && ok "a long numeric argument reaches the page exactly" || bad "numeric argument precision" "$seen"
# A probe that throws must be reported as broken, never as "no observable change".
dopen
ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "window.__argus.settled = () => { throw new Error(\"torn\") }; return 1" >/dev/null'
R=$("$ARGUS" --json click "button:Show notice" 2>/dev/null)
[[ $(jq -r '.diagnosis.reason' <<<"$R") == probe-error ]] && ok "a broken probe is reported as broken, not as no change" || bad "probe-error surfaced" "$R"
rm -rf "$TMPF"

printf '\n\033[2mresponsive\033[0m\n'
OVF="file://$PWD/test/overflow.html"
"$ARGUS" viewport 390x844 >/dev/null 2>&1
"$ARGUS" --json open "$OVF" >/dev/null 2>&1
R=$("$ARGUS" --json audit 2>/dev/null)
jq -e '[.findings[]|select(.rule=="overflow-x")|.examples[].at]|index("table.visually-hidden")' <<<"$R" >/dev/null \
  && ok "a visually-hidden table that widens a phone page is caught" || bad "hidden table overflow" "$R"
# A wide table inside its own scroll container is correct and must not be flagged.
jq -e '[.findings[]|select(.rule=="overflow-x")|.examples[].at]|any(test("table.wide"))|not' <<<"$R" >/dev/null \
  && ok "a wide table inside a scroller is not flagged" || bad "scroller false positive" "$R"
# The bug this pins: measuring against innerWidth, which the overflow itself inflates.
[[ $(jq -r .viewport <<<"$R") == 390x844 ]] && ok "overflow is measured against the device width" || bad "device width" "$(jq -r .viewport <<<"$R")"
"$ARGUS" viewport 1280x800 >/dev/null 2>&1
"$ARGUS" --json open "$OVF" >/dev/null 2>&1
"$ARGUS" viewport 390x844 >/dev/null 2>&1
scale=$(ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "return visualViewport.scale"')
[[ $scale == 1 ]] && ok "switching width on a loaded page does not leave it zoomed out" || bad "zoom reset" "$scale"
SHOT=$(mktemp --suffix=.png)
out=$("$ARGUS" shot "$SHOT" 2>/dev/null)
dims=$(python3 -c 'import struct,sys; print("%dx%d" % struct.unpack(">II", open(sys.argv[1],"rb").read(24)[16:24]))' "$SHOT" 2>/dev/null)
[[ $dims == 390x844 ]] && ok "shot captures the emulated viewport ($dims)" || bad "shot dimensions" "$dims"
[[ $out == *"~434 "* ]] && ok "shot reports ceil(w/28)*ceil(h/28) visual tokens" || bad "shot token math" "$out"
rm -f "$SHOT"
"$ARGUS" viewport reset >/dev/null 2>&1

printf '\n\033[2mkeyboard\033[0m\n'
"$ARGUS" --json open "$FIXTURE" >/dev/null 2>&1
dismiss
R=$("$ARGUS" --json key Tab 2>/dev/null)
jq -e '.delta.focus.to | test("^(button|link|textbox)")' <<<"$R" >/dev/null \
  && ok "a Tab reports where focus went" || bad "focus reported" "$R"

printf '\n\033[2mlanding page (site/index.html)\033[0m\n'
SITE="file://$PWD/site/index.html"
for vp in 1280x800 768x1024 390x844 320x640; do
  "$ARGUS" viewport $vp >/dev/null 2>&1
  "$ARGUS" --json open "$SITE" >/dev/null 2>&1
  sc=$("$ARGUS" --json audit 2>/dev/null | jq -r '.score')
  [[ $sc == 100 ]] && ok "audits clean at $vp" || bad "landing page at $vp" "score $sc: $("$ARGUS" --json audit | jq -c '[.findings[]|{rule,count}]')"
done
"$ARGUS" viewport 1280x800 >/dev/null 2>&1
"$ARGUS" --json open "$SITE" >/dev/null 2>&1
"$ARGUS" key Tab >/dev/null 2>&1
R=$("$ARGUS" --json key Enter 2>/dev/null)
[[ $(jq -r '.delta.focus.to' <<<"$R") == "main#main" ]] && ok "the skip link moves focus into the content" || bad "skip link focus" "$R"
R=$("$ARGUS" --json click "button:Switch to" 2>/dev/null)
theme_ok=$(ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "const t=document.getElementById(\"theme-toggle\"); return getComputedStyle(t.querySelector(\".icon-moon\")).display !== getComputedStyle(t.querySelector(\".icon-sun\")).display"')
ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "try{localStorage.removeItem(\"argus-theme\")}catch(e){} return 1" >/dev/null'
[[ $theme_ok == true ]] && ok "the theme toggle renders exactly one icon after a click" || bad "theme icon" "$theme_ok"
"$ARGUS" viewport reset >/dev/null 2>&1

printf '\n\033[2meyes\033[0m\n'
"$ARGUS" --json open "$FIXTURE" >/dev/null 2>&1
R=$("$ARGUS" --json look "button:Place order" 2>/dev/null)
[[ -f $(jq -r .image <<<"$R") && $(jq -r .reachable <<<"$R") == false && $(jq -r .coveredBy <<<"$R") == div#scrim ]] \
  && ok "look crops a covered element and says what covers it" || bad "look at a covered element" "$R"
[[ $(jq -r .tokens <<<"$R") -lt 100 ]] && ok "a one-element look costs under 100 visual tokens (~$(jq -r .tokens <<<"$R"))" || bad "look cost" "$R"
R=$("$ARGUS" --json marks 2>/dev/null)
jq -e '[.marks[]|select(.target=="button:Accept")][0].reachable == true and ([.marks[]|select(.target=="button:Place order")][0].reachable == false)' <<<"$R" >/dev/null \
  && ok "marks number every control and flag the covered ones" || bad "marks reachability" "$(jq -c '.marks[:3]' <<<"$R")"
# The marks overlay must not outlive the capture -- it would intercept nothing, but it is not the page.
leftover=$(ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "return !!document.getElementById(\"__argus_marks\")"')
[[ $leftover == false ]] && ok "the marks overlay is removed after capture" || bad "marks overlay left behind" "$leftover"
dismiss
R=$("$ARGUS" --json --see click "button:Place order" 2>/dev/null)
jq -e '.delta.visual | .changed and (.regions|length) >= 1 and (.regions|length) <= 4 and .tokens < 400' <<<"$R" >/dev/null && [[ -f $(jq -r .delta.visual.image <<<"$R") ]] \
  && ok "a seen action returns only the changed regions (~$(jq -r .delta.visual.tokens <<<"$R") visual tokens)" || bad "visual delta" "$(jq -c .delta.visual <<<"$R")"
# A key press after a mouse click switches Chrome to keyboard focus styling, so
# the clicked button gains its focus ring: a real change no text delta can show.
R=$("$ARGUS" --json --see key Escape 2>/dev/null)
jq -e '.delta.visual.changed and (.delta.visual.regions|length) == 1' <<<"$R" >/dev/null \
  && ok "a CSS-only change (a focus ring appearing) is seen" || bad "focus ring seen" "$(jq -c .delta.visual <<<"$R")"
# With nothing focused and nothing to escape, the same key changes nothing.
ARGUS_LANE=$ARGUS_LANE bash -c 'source lib/wire.sh; source lib/trace.sh; session_open >/dev/null 2>&1; js_raw "document.activeElement && document.activeElement.blur(); return 1" >/dev/null'
R=$("$ARGUS" --json --see key Escape 2>/dev/null)
[[ $(jq -r .delta.visual.changed <<<"$R") == false ]] && ok "an action that changes nothing on screen says so" || bad "no visual change" "$(jq -c .delta.visual <<<"$R")"
M=$({ jq -nc --arg f "$FIXTURE" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"browser_marks",arguments:{lane:32}}}'; } | ./bin/argus-mcp-legacy 2>/dev/null)
jq -e '.result.content | map(.type) | index("image")' <<<"$M" >/dev/null \
  && ok "over MCP the image itself is in the result, not just a path" || bad "mcp image block" "$(jq -c '[.result.content[].type]' <<<"$M")"
"$ARGUS" --lane 32 close >/dev/null 2>&1

if [[ ${ARGUS_TEST_OWN:-0} == 1 ]]; then
  printf '\n\033[2mown browser (ARGUS_TEST_OWN=1: a throwaway Chromium with the extension)\033[0m\n'
  # Everything here talks to the throwaway browser's own socket. The person's
  # real bridge must be exactly as connected afterwards as it was before.
  export ARGUS_BRIDGE_SOCK=${XDG_RUNTIME_DIR}/argus/throwaway/bridge.sock
  real_before=$(ARGUS_BRIDGE_SOCK= ./bin/argus own status 2>/dev/null | grep -c 'connected     yes')
  if ./test/throwaway-browser.sh start >/dev/null 2>&1; then
    ok "the extension connects through its native host"
    O="$ARGUS --own --lane 40"  # legacy own lanes (ARGUS is argus-legacy here)
    BASE=http://127.0.0.1:8765/test
    if ! curl -sf -o /dev/null "$BASE/fixture.html"; then
      bad "own-browser tests need the page server" "run: python3 -m http.server 8765 --bind 127.0.0.1"
    else
      R=$($O --json open "$BASE/fixture.html" 2>/dev/null)
      jq -e '(.delta.added|length) > 3 and ([.delta.console[]?.text]|any(test("tracking id")))' <<<"$R" >/dev/null \
        && ok "a brand-new lane's first load is fully observed, parse errors included" || bad "first load over the bridge" "$(jq -c '{added:(.delta.added|length), console:.delta.console}' <<<"$R")"
      R=$($O --json click "button:Place order" 2>/dev/null)
      [[ $(jq -r .diagnosis.coveredBy <<<"$R") == div#scrim ]] && ok "a covered click is diagnosed in the person's browser" || bad "covered over bridge" "$R"
      t0=$(date +%s%3N); R=$($O --json look "button:Place order" 2>/dev/null); ms=$(( $(date +%s%3N) - t0 ))
      [[ $(jq -r .tokens <<<"$R") -lt 100 && $ms -lt 3000 ]] && ok "look works on a background tab without stalling (${ms}ms)" || bad "look over bridge" "${ms}ms $R"
      R=$($O --json marks 2>/dev/null)
      jq -e '[.marks[]|select(.target=="button:Accept")][0].reachable' <<<"$R" >/dev/null && ok "marks work over the bridge" || bad "marks over bridge" "$R"
      $O click "button:Accept" >/dev/null 2>&1
      R=$($O --json --see click "button:Place order" 2>/dev/null)
      jq -e '.delta.visual.changed and (.delta.visual.whole|not) and (.delta.visual.regions|length) >= 1' <<<"$R" >/dev/null \
        && ok "a visual delta survives a scrollbar appearing" || bad "visual delta over bridge" "$(jq -c .delta.visual <<<"$R")"
      $O open "$BASE/dialogs.html" >/dev/null 2>&1
      R=$($O --json click "button:Delete account" 2>/dev/null)
      [[ $(jq -r '.delta.dialogs[0].answer' <<<"$R") == dismissed ]] && ok "dialogs are answered and reported in the person's browser" || bad "dialog over bridge" "$R"
      R=$($O --json upload "Upload avatar" "$ROOTDIR/test/fixture.html" 2>/dev/null)
      jq -e '[.delta.added[]]|any(test("fixture.html"))' <<<"$R" >/dev/null && ok "upload works over the bridge" || bad "upload over bridge" "$R"
      [[ $($O --json trace -n 1 2>/dev/null | jq -r .lane) == own-40 ]] && ok "own lanes are traced under their own identity" || bad "own lane id" ""
    fi
    # The one rule: a lane argus never opened cannot be addressed at all.
    R=$(printf '{"op":"cdp","lane":"never-opened","method":"Runtime.evaluate","params":{"expression":"1"}}\n' | socat -t 5 - "UNIX-CONNECT:$ARGUS_BRIDGE_SOCK" 2>/dev/null)
    [[ $(jq -r .ok <<<"$R") == false ]] && ok "a tab argus did not open cannot be addressed" || bad "bridge scoping" "$R"
    sock_mode=$(stat -c %a "$ARGUS_BRIDGE_SOCK" 2>/dev/null)
    [[ $sock_mode == 600 ]] && ok "the bridge socket is private to this user (mode $sock_mode)" || bad "socket mode" "$sock_mode"
    "$ARGUS" --own shutdown >/dev/null 2>&1
    left=$(printf '{"op":"lanes"}\n' | socat -t 5 - "UNIX-CONNECT:$ARGUS_BRIDGE_SOCK" 2>/dev/null | jq -r '.result|length')
    [[ $left == 0 ]] && ok "shutdown closes argus's tabs and leaves the browser running" || bad "own shutdown" "$left lanes left"
    ./test/throwaway-browser.sh stop >/dev/null 2>&1
    real_after=$(ARGUS_BRIDGE_SOCK= ./bin/argus own status 2>/dev/null | grep -c 'connected     yes')
    [[ $real_after == "$real_before" ]] && ok "the person's real bridge is untouched by these tests (connected=$real_after)" \
      || bad "the person's real bridge is untouched" "connected went $real_before -> $real_after"
  else
    bad "the extension connects through its native host" "$(tail -3 "${XDG_RUNTIME_DIR}/argus/throwaway/chromium.log" 2>/dev/null)"
  fi
  unset ARGUS_BRIDGE_SOCK
fi

if [[ ${ARGUS_TEST_DESK:-0} == 1 ]]; then
  printf '\n\033[2mdesk (ARGUS_TEST_DESK=1: creates a virtual monitor)\033[0m\n'
  SOCK=${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket2.sock
  SPYLOG=$(mktemp)
  "$ARGUS" desk down >/dev/null 2>&1
  "$ARGUS" desk up >/dev/null 2>&1
  DESKMON=$(jq -r .output "$STATE/desk.json" 2>/dev/null)
  [[ -n $DESKMON ]] && hyprctl monitors all -j | jq -e --arg o "$DESKMON" 'any(.[];.name==$o)' >/dev/null \
    && ok "desk up creates a virtual monitor ($DESKMON)" || bad "desk up creates a monitor" "$DESKMON"

  # Listen, never dispatch: the only honest way to prove focus was not taken.
  timeout 40 socat -u UNIX-CONNECT:"$SOCK" - > "$SPYLOG" 2>/dev/null & SPY=$!
  sleep 0.4
  D="$ARGUS --json --desk --lane 5"
  O=$($D open "$FIXTURE" 2>/dev/null)
  jq -e '.delta.desktop.opened|length>0' <<<"$O" >/dev/null \
    && ok "a desk lane is a real window, and the delta says so" || bad "desk open reports a window" "$O"
  W=$(hyprctl clients -j | jq -c '[.[]|select(.class=="argus-desk")][0]')
  mon_id=$(hyprctl monitors all -j | jq -r --arg o "$DESKMON" '.[]|select(.name==$o)|.id')
  [[ $(jq -r .workspace.name <<<"$W") == 91 && $(jq -r .monitor <<<"$W") == "$mon_id" ]] \
    && ok "it lives on the desk workspace, on the virtual monitor" || bad "desk window placement" "$W"
  hyprctl monitors all -j | jq -e --arg o "$DESKMON" '(.[]|select(.name==$o)) as $d | all(.[]|select(.name!=$o); (.x + .width) < $d.x or ($d.x + $d.width) < .x or (.y + .height) < $d.y or ($d.y + $d.height) < .y)' >/dev/null \
    && ok "the desk monitor touches no real monitor, so a mouse cannot wander onto it" || bad "desk monitor is isolated" "$(hyprctl monitors all -j | jq -c '[.[]|{name,x,y,width,height}]')"
  [[ $(hyprctl monitors all -j | jq -r --arg o "$DESKMON" '.[]|select(.name==$o)|.activeWorkspace.id') == 91 ]] \
    && ok "the virtual monitor shows the desk, so the compositor renders it" || bad "desk workspace visible on its monitor" ""
  addr=$(jq -r .address <<<"$W"); size=$(jq -c .size <<<"$W")
  "$ARGUS" --json --desk --lane 6 open "$FIXTURE" >/dev/null 2>&1
  [[ $(hyprctl clients -j | jq -c --arg a "$addr" '.[]|select(.address==$a)|.size') == "$size" && $size == "[1280,800]" ]] \
    && ok "a second agent window does not resize the first ($size)" || bad "desk window size stable" "$size -> $(hyprctl clients -j | jq -c --arg a "$addr" '.[]|select(.address==$a)|.size')"
  "$ARGUS" --desk --lane 6 close >/dev/null 2>&1
  $D click "button:Accept" >/dev/null 2>&1
  P=$($D click "button:Open payment window" 2>/dev/null)
  jq -e '[.delta.desktop.opened[].title]|any(test("Argus popup"))' <<<"$P" >/dev/null \
    && ok "a popup is reported as an OS window opening" || bad "popup in compositor delta" "$P"
  X=$($D click "button:Present fullscreen" 2>/dev/null)
  jq -e '(.delta.desktop.fullscreen|length>0)' <<<"$X" >/dev/null \
    && ok "fullscreen is reported from the compositor" || bad "fullscreen in compositor delta" "$X"
  jq -e '.delta.focusRestored' <<<"$P$X" >/dev/null 2>&1 \
    && bad "no action needed its focus restored" "guard fired" || ok "no action needed its focus restored"
  sleep 0.5; kill $SPY 2>/dev/null; wait $SPY 2>/dev/null
  stolen=$(grep -cE "^(workspace|workspacev2)>>91|^focusedmon(v2)?>>$DESKMON" "$SPYLOG")
  [[ $stolen -eq 0 ]] && ok "focus never arrived at the desk ($(wc -l < "$SPYLOG") compositor events watched)" \
    || bad "focus never arrived at the desk" "$(grep -E "91|$DESKMON" "$SPYLOG" | head -3)"
  rm -f "$SPYLOG"

    # Removing a monitor makes Hyprland warp the cursor to a monitor centre; desk
  # down must put it back. Never moves the cursor itself: it only checks that
  # a cursor which was not at a centre is not left at one.
  cur_before=$(hyprctl cursorpos | tr -d ' ')
  centres=$(hyprctl monitors -j | jq -r '.[] | "\(.x + ((.width / .scale) / 2 | floor)),\(.y + ((.height / .scale) / 2 | floor))"')
"$ARGUS" desk down >/dev/null 2>&1
  cur_after=$(hyprctl cursorpos | tr -d ' ')
  if grep -qx -- "$cur_before" <<<"$centres" || ! grep -qx -- "$cur_after" <<<"$centres" || [[ $cur_after == "$cur_before" ]]; then
    ok "desk down leaves the cursor where it was"
  else
    bad "desk down leaves the cursor where it was" "$cur_before -> $cur_after (a monitor centre)"
  fi
  hyprctl monitors all -j | jq -e --arg o "$DESKMON" 'any(.[];.name==$o)|not' >/dev/null \
    && ok "desk down removes the monitor" || bad "desk down removes the monitor" "$DESKMON still present"
  [[ $(hyprctl clients -j | jq '[.[]|select(.class=="argus-desk")]|length') -eq 0 ]] \
    && ok "desk down leaves no windows behind" || bad "desk windows left behind" ""
fi

if [[ ${ARGUS_TEST_NESTED:-0} == 1 ]]; then
  printf '\n\033[2mnested desktop (ARGUS_TEST_NESTED=1: a Hyprland inside the desk)\033[0m\n'
  N="$ARGUS nest"
  me_env=$(systemctl --user show-environment 2>/dev/null | grep -E '^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE)=' | sort)
  $N down nt >/dev/null 2>&1
  out=$($N up nt 2>&1)
  [[ $out == *"nest nt up"* ]] && ok "a nested desktop starts on the desk (${out##*(}" || bad "nest up" "$out"
  [[ $(hyprctl clients -j | jq --arg p "$(jq -r .pid "$STATE/nests/nt.json")" '[.[]|select((.pid|tostring)==$p)][0].workspace.id') == "${ARGUS_DESK_WS:-91}" ]] \
    && ok "it lives on the desk, not the person's screen" || bad "nest placement" ""
  # Listen, never dispatch: focus reaching the nest's window or the desk is the
  # only failure. Comparing the active window before and after instead failed
  # whenever the person simply switched windows during the run.
  NSPY=$(mktemp)
  timeout 60 socat -u UNIX-CONNECT:"$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock" - > "$NSPY" 2>/dev/null & NSPYPID=$!
  nest_addr=$(hyprctl clients -j | jq -r --arg p "$(jq -r .pid "$STATE/nests/nt.json")" '[.[]|select((.pid|tostring)==$p)][0].address' | sed 's/^0x//')
  APP=$($N run nt -- python3 "$ROOTDIR/test/fixture-app.py" argus-nest-app)
  for _ in $(seq 1 60); do python3 lib/atspi.py find "$APP" "button:Add" >/dev/null 2>&1 && break; sleep 0.1; done
  labels() { python3 lib/atspi.py json "$APP" 2>/dev/null | jq -c '[.[]|select(.role=="label")|.name]'; }
  until_label() { for _ in $(seq 1 40); do labels | grep -qF "\"$1\"" && return 0; sleep 0.05; done; return 1; }
  $N click-on nt "$APP" "text:New item" >/dev/null && $N type nt "Oat milk" \
    && $N click-on nt "$APP" "checkbox:Urgent" >/dev/null && $N click-on nt "$APP" "button:Add" >/dev/null
  until_label "! Oat milk" && until_label "1 item" \
    && ok "real clicks and typing operate a native app, verified in its tree" || bad "nest click/type" "$(labels)"
  python3 lib/atspi.py find "$APP" "checkbox:Urgent" | jq -e '.states|index("checked")' >/dev/null \
    && ok "a check box with no accessibility action is clicked with the nest's own pointer" || bad "nest checkbox" ""
  $N click-on nt "$APP" "text:New item" >/dev/null && $N type nt "Eggs" && $N key nt Return
  until_label "2 items" && ok "keys reach the focused widget inside the nest" || bad "nest key" "$(labels)"
  shot=$($N shot nt 2>&1)
  [[ -s $STATE/nests/nt/shot.png && $shot == *"1280x800"* ]] && ok "the nest can be seen (${shot#* })" || bad "nest shot" "$shot"
  sleep 0.3; kill "$NSPYPID" 2>/dev/null; wait "$NSPYPID" 2>/dev/null
  stolen=$(grep -E "^activewindowv2>>$nest_addr\$|^(workspace|workspacev2)>>${ARGUS_DESK_WS:-91}|^focusedmon(v2)?>>HEADLESS" "$NSPY")
  [[ -n $nest_addr && -z $stolen ]] && ok "focus never reached the nest or the desk ($(wc -l < "$NSPY") compositor events watched)" \
    || bad "focus never reached the nest" "addr=$nest_addr ${stolen:0:120}"
  rm -f "$NSPY"
  ref=$(bun argusd/src/main.ts pointer "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" 1920x1080 move 1 1 2>&1)
  [[ $ref == *"refusing to drive"* ]] && ok "the pointer refuses the person's own compositor" || bad "pointer guard" "$ref"
  [[ $(systemctl --user show-environment 2>/dev/null | grep -E '^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE)=' | sort) == "$me_env" ]] \
    && ok "the nest never enters the person's session environment" || bad "session environment unchanged" "$(systemctl --user show-environment | grep -E '^(WAYLAND_DISPLAY|HYPRLAND_INSTANCE_SIGNATURE)=')"
  npid=$(jq -r .pid "$STATE/nests/nt.json"); nwd=$(jq -r .watchdog "$STATE/nests/nt.json")
  $N down nt >/dev/null
  ! kill -0 "$npid" 2>/dev/null && ! kill -0 "$nwd" 2>/dev/null && ! kill -0 "$APP" 2>/dev/null && [[ ! -e $STATE/nests/nt.json ]] \
    && ok "down stops the nest and every app started in it" || bad "nest down" "nest $npid app $APP"
fi

printf '\n\033[2mown-browser installer (on a copy, never the real config)\033[0m\n'
IT=$(mktemp -d)
mkdir -p "$IT/home/.config/chromium"
printf -- '--ozone-platform=wayland\n--load-extension=/opt/a,/opt/b\n' > "$IT/home/.config/chromium-flags.conf"
before=$(sha256sum < "$IT/home/.config/chromium-flags.conf")
inst() { HOME="$IT/home" XDG_RUNTIME_DIR="$IT/run" ./bin/argus-own "$@" >/dev/null 2>&1; }
inst install
grep -qx -- "--load-extension=/opt/a,/opt/b,$ROOTDIR/extension" "$IT/home/.config/chromium-flags.conf" \
  && ok "joins Chromium's existing extension list instead of adding a second flag" || bad "flag edit" "$(cat "$IT/home/.config/chromium-flags.conf")"
jq -e --arg id "$(jq -r .key extension/manifest.json | base64 -d | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')" \
  '.allowed_origins == ["chrome-extension://\($id)/"]' "$IT/home/.config/chromium/NativeMessagingHosts/com.omarchy.argus.json" >/dev/null \
  && ok "the native host allows exactly one extension" || bad "host manifest" "$(cat "$IT/home/.config/chromium/NativeMessagingHosts/com.omarchy.argus.json")"
once=$(sha256sum < "$IT/home/.config/chromium-flags.conf"); inst install
[[ $(sha256sum < "$IT/home/.config/chromium-flags.conf") == "$once" ]] && ok "installing twice changes nothing" || bad "install idempotent" ""
inst uninstall
[[ $(sha256sum < "$IT/home/.config/chromium-flags.conf") == "$before" ]] && ok "uninstall restores the flags byte for byte" || bad "uninstall restore" "$(cat "$IT/home/.config/chromium-flags.conf")"
rm -rf "$IT"

printf '\n\033[2mprocess ownership\033[0m\n'
# Argus must never touch a browser it did not start. A cleanup that matched
# processes by name killed the user's own Chromium -- and the extension driving
# it -- more than once. A decoy whose process name is "chromium" must survive.
DECOY_DIR=$(mktemp -d)
cp /usr/bin/sleep "$DECOY_DIR/chromium"
setsid "$DECOY_DIR/chromium" 120 >/dev/null 2>&1 </dev/null & disown
sleep 0.3
decoy=$(pgrep -x chromium -n)
"$ARGUS" --lane 33 open "$FIXTURE" >/dev/null 2>&1
"$ARGUS" shutdown >/dev/null 2>&1
sleep 0.5
kill -0 "$decoy" 2>/dev/null && ok "shutdown leaves a browser it did not start alone" || bad "shutdown killed a foreign chromium" "pid $decoy gone"
left=$(pgrep -x chromium 2>/dev/null | while read -r p; do tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--user-data-dir=/tmp/.org.chromium.Chromium.' && echo "$p"; done | wc -l)
[[ $left -eq 0 ]] && ok "shutdown stops every browser argus did start" || bad "argus browsers survived shutdown" "$left left"
kill "$decoy" 2>/dev/null; rm -rf "$DECOY_DIR"

printf '\n\033[2mcost\033[0m\n'
reset; dismiss
n=$("$ARGUS" --json click "button:Place order" 2>/dev/null | wc -c)
[[ $n -lt 1200 ]] && ok "a delta stays under 300 tokens (~$((n/4)))" || bad "delta size" "$n chars"

"$ARGUS" close >/dev/null 2>&1
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
