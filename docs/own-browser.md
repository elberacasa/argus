# Own lanes: argus in your own Chromium

`argus --own` drives tabs in the Chromium you already use, with your logins.
Headless and desk lanes use throwaway profiles and cannot act on your accounts;
own lanes can. That is the point, and it is why this mode is built the way it
is.

```
argus own install              # once; then restart Chromium
argus --own open https://mail.example.com
argus --own click "button:Compose"
argus own status
argus own uninstall
```

## How it connects

```
argus  ──unix socket──▶  argus-bridge-host  ──native messaging──▶  Argus extension  ──chrome.debugger──▶  argus's tabs
       (0600, 0700 dir)   (launched by Chromium,                    (MV3, in your
                           only for this extension)                  own browser)
```

This is the pattern Omarchy uses for its own Chromium extensions, and the one
Claude in Chrome uses.

## What was deliberately not done

**No remote-debugging port.** Starting Chromium with `--remote-debugging-port`
would have been simpler. It would also let any process running as you connect
and read every cookie in your browser -- email, bank, everything -- with no
prompt and no trace. The native host is launched by Chromium itself, only for
one extension ID, and argus reaches it over a socket only your user can open.

**No access to your tabs.** Commands name a lane, never a tab id. A lane maps
only to a tab the extension created, and those tabs sit in a group titled
"Argus". There is no operation that can address any other tab; the test suite
checks that an unopened lane is refused.

**No cookie, history or storage permissions.** The extension asks for
`debugger`, `tabs`, `tabGroups`, `nativeMessaging` and `storage` (the last only
for its own lane bookkeeping). No host permissions.

**Downloads are not redirected.** In headless lanes argus sends downloads to its
own directory. In your browser that would change where *your* downloads go, so
own lanes leave download behaviour alone and report files that land in your
usual Downloads folder.

## One socket per browser, and never stealing one

The native host listens on `$XDG_RUNTIME_DIR/argus/bridge.sock`, or on the path
in `ARGUS_BRIDGE_SOCK` if the browser was started with it; the host inherits the
browser's environment. Tests start their throwaway browser with its own socket,
so they cannot reach the person's real one.

A host that finds its socket already live never takes it: it waits, and claims
the socket only if the owner goes away. An earlier version let the newest host
take the socket, which a full health check caught: running the own-browser tests
cut argus off from the person's real browser, because the test browser's host
took the socket and deleted it on exit. The suite now asserts the real bridge is
exactly as connected after those tests as before.

## What you will see

- Tabs argus opens, in a group titled **Argus**, opened in the background.
- Chromium's own banner saying Argus is debugging the browser, while it is
  attached. **Cancelling that banner stops argus** on that tab; the lane is
  released rather than silently re-attached.

## Surviving Omarchy updates

`omarchy-refresh-chromium` rewrites `~/.config/chromium-flags.conf` from
Omarchy's defaults, which would drop the extension. `argus own install` adds an
Omarchy post-update hook that reapplies it after `omarchy update`. After a
manual refresh, `argus own status` reports the extension missing and
`argus own install` restores it. Install and uninstall are both safe to repeat;
uninstall restores the flags file byte for byte (tested on a copy).

## Background tabs, measured

Own lanes are background tabs. On a **headless** throwaway browser, Chromium did
not render them continuously:

- An unclipped screenshot waited for a frame that never came and stalled for a
  full minute. Captures are now always clipped.
- A clipped capture stalled on the first request and returned in ~50ms on the
  second, every time. Captures use a 0.5s / 3s / 5s ladder: `look` went from
  5.1s to 134ms there.

In the person's **real, visible** Chromium (Omarchy, Hyprland, Wayland), the
same operations on a background tab in their window:

```
open, parse-time error caught     584ms   settled 383ms
covered click, diagnosed           56ms
look at a covered button      124-216ms   28 visual tokens
marks, 11 elements                125ms
--see click, 2 regions            1.1s    162 visual tokens, settled 251ms
```

Background tabs render reliably there, so argus's tabs stay in the person's
window rather than needing a window of their own on the desk.
