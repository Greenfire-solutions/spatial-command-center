# Getting a developer into the workspace

Per machine, start to finish, about ten minutes, most of it a one-time browser
setting on the headset.

## The shape of it, before the steps

**One developer, one machine, one headset.** The host drives real Chromium
windows and hands control of them to whoever connects, so it accepts exactly one
client at a time; a second headset is closed with code 4409
(`electron/host/remote-host.cjs`). This is a deliberate constraint rather than a
limit to raise: two people sharing a host would be typing into the same browser
windows, scrolling each other's pages, and navigating each other away from them.

So a team of five is five laptops each running `npm run vr`, each paired with one
headset. There is no server to stand up and nothing shared between developers.

## On the machine

```
git clone <repo> && cd <repo>
npm install
npm run vr
```

That is the whole thing. `npm run vr` builds the workspace, starts the browser
host, starts the page server, mints one token and gives it to both halves, and
prints the URL to open. Stop it with Ctrl+C and both halves stop together.

The printed URL contains the machine's LAN address, which differs per machine and
changes when the network does. Read it from the terminal rather than copying a
teammate's.

## On the headset

The headset must be on the same Wi-Fi as the machine. Office networks with
client isolation block device-to-device traffic entirely; if the page will not
load at all, that is the first thing to suspect.

**One-time, per headset.** WebXR is only exposed in a secure context, and a LAN
address over plain HTTP is not one, so without this the workspace loads but the
ENTER VR button does not exist:

1. Open `chrome://flags` in the headset browser
2. Find **Insecure origins treated as secure**, set it to **Enabled**
3. In its text box put both origins, comma-separated, no spaces, substituting the
   address from your own terminal:
   `http://192.168.1.28:4173,http://192.168.1.28:8787`
4. Tap **Relaunch**

The second origin is the browser stream. Without it Chromium may treat the
WebSocket as mixed content once the page origin counts as trustworthy, and every
window goes blank while the page itself looks fine.

**Every time.** Open the address the terminal printed, just the origin, nothing
after the slash:

```
192.168.1.28:4173
```

Then tap **ENTER VR**. Bookmark it; the server tells the page where its host is,
so a bookmark keeps working and no token is ever typed.

### The alternative, if the flag is unacceptable

`npm run vr -- --https` serves TLS instead, which is a real secure context and
needs no flag. The cost is that the certificate is self-signed, so the headset
warns once for the page and once more for the stream port, two different
origins, and the stream port's prompt has no interface, so it must be visited
directly and accepted before the workspace will show any page content.

Prefer the flag on a trusted network. Prefer TLS if the network is not yours.

## Inside the workspace

| Input | Does |
| --- | --- |
| Trigger / pinch | Click, exactly as a mouse click |
| **Right thumbstick click** | **New window, placed in front of you, address field open** |
| Left thumbstick click | Show the keyboard for the focused window |
| Left thumbstick | Move, relative to where you are looking |
| Right thumbstick | Turn, and altitude on Y |
| Grip | Grab a window; both grips scale it |
| Right B | Hold to dictate |

Typing uses the headset's own system keyboard where the runtime offers one, which
brings swipe, punctuation and dictation. Where it does not, an in-scene keyboard
is drawn instead. Both edit the same field, so nothing above them changes.

## When something is wrong

The headset has no console you can read while wearing it, so the workspace
reports to the machine instead. Every session appends to `.cache/xr-diag.log`,
and the terminal prints each line as it arrives, prefixed `[headset]`.

```
tail -f .cache/xr-diag.log
```

That file answers the questions worth asking first: whether the page is in a
secure context, whether `navigator.xr` exists, which session modes the runtime
admits to, whether the system keyboard is offered, and the reason any session
request was refused.

| Symptom | Cause |
| --- | --- |
| Page will not load at all | Different Wi-Fi, or client isolation on the network |
| Loads, but no ENTER VR button | Not a secure context, the flag step was missed or the browser was not relaunched |
| In VR, every window blank | The stream port was left out of the flag, or the host is not running |
| Windows say Chromium is offline | The page was opened without its injected config, open the origin, not an old link |

## Security, stated plainly

`npm run vr` binds the browser host beyond loopback so a headset can reach it,
and the host says so on startup. Anyone on that network who reaches the port with
the token controls a real browser on that machine. That is acceptable on a
trusted network for a working session; it is not something to leave running
overnight, and it is not something to do on conference Wi-Fi.

The token is minted per run, so stopping and restarting invalidates the old one.
