# Head to head, 2026-09-17

Argus and Claude in Chrome, driven by the same model (Claude Opus 5) through `claude -p`, on
[UI Testing Playground](http://uitestingplayground.com). Produced by `argusd/bench/h2h.ts --rounds 2`;
the write-up is in [benchmark-uitap.md](../../benchmark-uitap.md).

Goals are judged from the page itself: both tools opened the pages through a local proxy that injected a
reporter, which sent real clicks and page state to the harness. Neither tool graded itself.

| | Goals met | False successes | Tool calls | Time | Input + output tokens | Cost |
|---|---:|---:|---:|---:|---:|---:|
| Argus | 20/20 | 0 | 67 | 252 s | 755,988 + 7,521 | $0.85 |
| Claude in Chrome | 20/20 | 0 | 82 | 620 s | 1,621,943 + 17,673 | $1.87 |

## Every session

Each log has every call the model made, what the tool returned, the images the model
was shown, and its final answer. Removed: session metadata (settings, local paths) and system reminders a tool
appends for the model. Results longer than 2,000 characters are truncated and marked.

| Challenge | Round | Argus | Claude in Chrome |
|---|---:|---|---|
| Hidden Layers | 1 | [met · 5 calls · 14.6 s](runs/argus-hiddenlayers-1.md) (green pressed 1×) | [met · 5 calls · 25.6 s](runs/chrome-hiddenlayers-1.md) (green pressed 1×) |
| Overlapped | 1 | [met · 4 calls · 12.3 s](runs/argus-overlapped-1.md) (name = "Argus") | [met · 4 calls · 23.7 s](runs/chrome-overlapped-1.md) (name = "Argus") |
| Visibility | 1 | [met · 6 calls · 16.9 s](runs/argus-visibility-1.md) (Hide applied; 7/7 answered not clickable) | [met · 4 calls · 33.3 s](runs/chrome-visibility-1.md) (Hide applied; 7/7 answered not clickable) |
| Click | 1 | [met · 3 calls · 9.7 s](runs/argus-click-1.md) (turned green) | [met · 4 calls · 23.7 s](runs/chrome-click-1.md) (turned green) |
| Text Input | 1 | [met · 2 calls · 8.7 s](runs/argus-textinput-1.md) (button reads "Argus") | [met · 3 calls · 20.6 s](runs/chrome-textinput-1.md) (button reads "Argus") |
| Client Side Delay | 1 | [met · 2 calls · 23.3 s](runs/argus-clientdelay-1.md) (label clicked 1×) | [met · 5 calls · 42.7 s](runs/chrome-clientdelay-1.md) (label clicked 1×) |
| Non-Breaking Space | 1 | [met · 2 calls · 8.6 s](runs/argus-nbsp-1.md) (My Button clicked 1×) | [met · 3 calls · 20.6 s](runs/chrome-nbsp-1.md) (My Button clicked 1×) |
| Scrollbars | 1 | [met · 3 calls · 10.9 s](runs/argus-scrollbars-1.md) (hidden button clicked 1×) | [met · 4 calls · 25.9 s](runs/chrome-scrollbars-1.md) (hidden button clicked 1×) |
| Shadow DOM | 1 | [met · 4 calls · 11.9 s](runs/argus-shadowdom-1.md) (field "95651c2f-79bb-9ff9-27e4-d00e566bc40b", reported 95651c2f-79bb-9ff9-27e4-d00e566bc40b) | [met · 3 calls · 18.2 s](runs/chrome-shadowdom-1.md) (field "47733ea2-2668-3025-4ebb-a480f34da46f", reported 47733ea2-2668-3025-4ebb-a480f34da46f) |
| Frames | 1 | [met · 3 calls · 10.6 s](runs/argus-frames-1.md) (inner "Button pressed: Edit", outer "") | [met · 3 calls · 16.3 s](runs/chrome-frames-1.md) (inner "Button pressed: Edit", outer "") |
| Hidden Layers | 2 | [met · 5 calls · 15.3 s](runs/argus-hiddenlayers-2.md) (green pressed 1×) | [met · 4 calls · 23.8 s](runs/chrome-hiddenlayers-2.md) (green pressed 1×) |
| Overlapped | 2 | [met · 4 calls · 12.5 s](runs/argus-overlapped-2.md) (name = "Argus") | [met · 4 calls · 20.7 s](runs/chrome-overlapped-2.md) (name = "Argus") |
| Visibility | 2 | [met · 5 calls · 12.4 s](runs/argus-visibility-2.md) (Hide applied; 7/7 answered not clickable) | [met · 4 calls · 30.4 s](runs/chrome-visibility-2.md) (Hide applied; 7/7 answered not clickable) |
| Click | 2 | [met · 3 calls · 9.6 s](runs/argus-click-2.md) (turned green) | [met · 4 calls · 24.8 s](runs/chrome-click-2.md) (turned green) |
| Text Input | 2 | [met · 2 calls · 8.3 s](runs/argus-textinput-2.md) (button reads "Argus") | [met · 3 calls · 19 s](runs/chrome-textinput-2.md) (button reads "Argus") |
| Client Side Delay | 2 | [met · 2 calls · 23.7 s](runs/argus-clientdelay-2.md) (label clicked 1×) | [met · 10 calls · 134.4 s](runs/chrome-clientdelay-2.md) (label clicked 1×) |
| Non-Breaking Space | 2 | [met · 2 calls · 8.7 s](runs/argus-nbsp-2.md) (My Button clicked 1×) | [met · 4 calls · 22.9 s](runs/chrome-nbsp-2.md) (My Button clicked 1×) |
| Scrollbars | 2 | [met · 3 calls · 11.1 s](runs/argus-scrollbars-2.md) (hidden button clicked 1×) | [met · 4 calls · 23 s](runs/chrome-scrollbars-2.md) (hidden button clicked 1×) |
| Shadow DOM | 2 | [met · 4 calls · 12.5 s](runs/argus-shadowdom-2.md) (field "51ecbf49-cc88-eb0a-2793-2440dba0dbce", reported 51ecbf49-cc88-eb0a-2793-2440dba0dbce) | [met · 4 calls · 51.6 s](runs/chrome-shadowdom-2.md) (field "bff598a3-e07a-1226-bcd4-0f5436a986f8", reported bff598a3-e07a-1226-bcd4-0f5436a986f8) |
| Frames | 2 | [met · 3 calls · 10.6 s](runs/argus-frames-2.md) (inner "Button pressed: Edit", outer "") | [met · 3 calls · 18.5 s](runs/chrome-frames-2.md) (inner "Button pressed: Edit", outer "") |
