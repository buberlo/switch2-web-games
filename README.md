# Switch 2 Web Games

An experimental toolkit for running web games in the Nintendo Switch 2 browser:
a local captive-portal enabler, game hosting, compatibility probes, controls,
saving and performance measurements. The long-term ambition is to support games
as demanding as GTA V; no specific commercial game is the target.

Diablo shareware is the first implementation. It runs on the console as
JavaScript; the Mac serves files and stores saves. A tested WebGL palette
renderer is available for supporting browsers, with a Canvas 2D fallback.
The measured Switch applet returns no WebGL context and uses Canvas.

**Current physical result:** an earlier optimized build reached 16.5–16.7 FPS
in the menu and 9.9–10.2 FPS in town, successfully creating a temporary warrior.
The newer town cache and Canvas improvements have passed local tests; physical
retest is pending. Dungeon gameplay and a ten-minute session are not qualified.

The broader game library follows that physical acceptance gate. See the
[roadmap](docs/roadmap.md), [verification record](docs/verification.md) and
[contribution guide](CONTRIBUTING.md). This is a local LAN project; publishing
the source does not host a public game service.

## Local setup and preview

Requires macOS, Python 3.9+, developer command-line tools and `dnsmasq` for the
console-facing DNS service. The engine compiler installs inside `.toolchain/`.
The current privileged-service tooling is tested on macOS. The server itself
has no Python package dependencies.

```sh
git clone https://github.com/buberlo/switch2-web-games.git
cd switch2-web-games
# Install command-line tools if missing:
xcode-select --install
# With Homebrew installed:
brew install python dnsmasq
python3 scripts/setup_assets.py
python3 scripts/build_engine.py
python3 server/portal.py --host 127.0.0.1 --port 8090
```

Open [the launcher](http://127.0.0.1:8090/portal), then **Play Diablo**. Diagnostics
are at [Browser check](http://127.0.0.1:8090/diagnostics). For a LAN preview use
`--host 0.0.0.0 --lan-ip <current-Mac-IP>` instead of the loopback host.

The setup verifies the pinned 25,830,791-byte shareware archive against SHA-256
`21d125650291d6099a4a49e325374add8fbc3ac17f97d64fac83bbdd3364f28f`.
Only shareware is downloaded. Compiler files, generated engine, game data,
saves and runtime evidence are ignored by Git.

## Enable the Switch captive portal

Connect the Mac and Switch to the same LAN. Find the Mac's current LAN IPv4
address and the router's IPv4 address. The commands below use **192.168.0.104**
and **192.168.0.1** as examples; replace them for your network. Keep the Mac awake
and reserve its address in the router if possible.

For a fresh setup, start the HTTP/DNS services from Terminal:

```sh
sudo /usr/bin/python3 scripts/rig.py start --lan-ip 192.168.0.104 --upstream 192.168.0.1
```

Enter your Mac password only in Terminal when sudo requests it. Binding ports
80/53 requires sudo; the HTTP process then drops to your normal account.
Existing unrelated port listeners are refused. To inspect the setup, use
`sudo /usr/bin/python3 scripts/rig.py doctor`.

If replacing the earlier `switch2-research` rig, specify its actual directory.
Inspect the proposed handoff first, then apply it:

```sh
python3 scripts/rig.py cutover --research-root /path/to/switch2-research --lan-ip 192.168.0.104 --upstream 192.168.0.1
sudo /usr/bin/python3 scripts/rig.py cutover --research-root /path/to/switch2-research --lan-ip 192.168.0.104 --upstream 192.168.0.1 --apply
```

The command preserves the research files and its 8080/443 services, records the
verified original commands, and restores them if starting the replacement fails.
It refuses unrelated listeners, changed process identities and conflicting PF
translations. It does not edit system DNS, PF or firewall rules. A fresh setup
does not depend on the research project.

On the Switch, keep IP settings **Automatic**, set the Wi-Fi connection's DNS to
**192.168.0.104** (both DNS fields if a secondary value is required), then run
**Connection Test**. Open the network login page if prompted. Nintendo connection
checks remain captive while the applet is open; unrelated domains use the router.

Open **Browser check** once, activate input listening, then press the Joy-Cons and
tap the screen. Return to **Play Diablo**. No launcher download or installation
on the Switch is required. Gamepad exposure on this HTTP origin is recorded as
observed; it is not assumed equivalent to another browser origin.

Status and stop for a fresh setup:

```sh
sudo /usr/bin/python3 scripts/rig.py status
sudo /usr/bin/python3 scripts/rig.py stop
```

After stopping, set Switch DNS to **Automatic**. If you performed a research
cutover, `sudo /usr/bin/python3 scripts/rig.py rollback --apply` instead restores
the previous research services and their original DNS behavior.

If a cutover stopped services but rollback was incomplete, recover and retry
using its saved addresses and original commands:

```sh
sudo /usr/bin/python3 scripts/rig.py retry-cutover --apply
```

This first completes the verified rollback, then starts a fresh cutover. It
stops if recovery fails and keeps the handoff journal. The port checks use the
same socket reuse behavior as the actual servers, and inspect foreign listeners
before stopping research services. An unrelated listener bound to the exact LAN
endpoint is refused; a wildcard listener can coexist only with measured binding
or currently observed owned-listener evidence.

## Controls and saves

- Tap/click to move, talk, pick up items and fight. Dragging holds the action.
- **Inventory**, **Character**, **Potion 1/2**, **Confirm**, and **Escape** are
  available below the game. **Spell** makes the next world clicks right-clicks
  until switched off. **Game menu** opens the in-game save/menu screen.
- Character naming uses a normal text field. Keyboard/mouse also work.
- If the browser exposes a standard gamepad, the left stick moves the cursor;
  south face button selects, east returns, west opens inventory, north opens
  character, shoulders use belt slots and right trigger uses the spell action.
- Save through **Game menu → Save Game**. Wait for **Saved on Mac** before
  leaving. Failed writes remain pending and **Retry saves** reconnects to the Mac.

There is one private local profile. Saves are in `data/saves/`; the server accepts
only `config.ini` and `spawn0.sv` through `spawn9.sv`, with bounded writes and a
same-origin session token. Saves are loaded before engine initialization, so no
IndexedDB, Web Locks, OPFS or service worker is required. The token is an origin
boundary, not a multi-user login; this service is intended for the private LAN.

## Engine and verification

The engine uses d07RiV/Devilution commit `798b512`, compiled with Emscripten 3.1.74
to JavaScript (`WASM=0`). The complete generated output is converted and checked
as ES5. It keeps the original 640×480 software framebuffer and 20 Hz loop, a
128 MiB initial engine heap, and a 256 MiB heap cap. The archive, JavaScript VM,
audio and display buffers consume additional memory.

A classic Worker is preferred after a handshake. If workers are unavailable,
the same adapter runs on the main thread and yields between ticks. The engine
never requires WebAssembly, WebGL or SharedArrayBuffer. `?compat=1` explicitly
removes WebAssembly in both page and worker; `&main=1` exercises the fallback.

The default build opens the main menu directly, before constructing the startup
movie decoder. Native typed-array copies/fills replace compiled memory loops;
masked menu art caches opaque row spans. The engine sends indexed pixels and a
palette, avoiding its per-pixel RGBA conversion. The page tests an actual GPU
shader and its copy to the visible Canvas before selecting WebGL. If that fails,
Canvas compares eight-row signatures, expands changed 32-pixel segments on
sparse rows, and handles dense rows directly. Native cached town tile spans
avoid repeated terrain decoding. No GPU feature is assumed from API presence
alone.

The display adapter allows one transferable frame in transit, combining dirty
rectangles while the page is busy. Silent hosts skip unused audio file decoding.
Character loading displays an overlay, measures the synchronous input callback,
and discards stale presses queued during loading while preserving releases.
Actual Switch performance of this revision remains to be measured. Comparison
builds support `--with-intro`, `--legacy-blit`, `--legacy-terrain`, and
`--legacy-memory`.

To fetch an updated build on an already running console, return to **Library**
and choose **Play Diablo**, then start it. If the applet has closed, run
**Connection Test** again. The server sends assets with `Cache-Control: no-store`;
frontend and engine updates do not require restarting the LAN services.

**Switch speed test** on the Library opens `/play/diablo?benchmark=1`. It starts
automatically, measures the menu, creates a temporary warrior, and measures town.
Keep the page visible and leave its controls still. This mode neither reads nor
writes the normal save profile and disables audio. It polls engine metadata and
repeats automatically after a new engine is published, once loading has finished.
The Mac records measurements and actual renderer capabilities. These short
measurements do not replace the physical gameplay acceptance session.

Run local checks:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node scripts/check_engine.cjs
node scripts/check_engine.cjs --scene town-reload --indexed --no-audio --frame-digests
node tests/test_frame_protocol.cjs
node tests/test_input_protocol.cjs
```

For browser checks, install Node.js 20.18+ and Google Chrome, then install the
pinned development dependencies. Run browser suites one at a time because they
use fixed local test ports. `PLAYWRIGHT_MODULE` can override the module location:

```sh
npm ci
node tests/browser_smoke.cjs
node tests/test_diagnostics.cjs
node tests/test_renderer.cjs
node tests/test_benchmark.cjs
SMOKE_GPU=1 node tests/browser_smoke.cjs
```

The gameplay browser test uses a temporary profile, checks creation, movement,
inventory, save/reload and the main-thread fallback with WebAssembly/WebGL
disabled, and writes screenshots/results into `data/qa/`. It does not overwrite
your normal saves. The diagnostics suite tests actual drawing/API execution,
input reporting and failure recovery. Renderer tests compare actual GPU and
Canvas pixels, including palette changes and context loss. The benchmark suite
checks automatic character creation, measured windows, build-change reload,
and an unchanged save profile. Network/socket permission is needed for
local tests. No GitHub Actions or remote CI is used.

## Physical acceptance gate

Desktop checks are not Switch gameplay evidence. Record the exact engine hash,
applet user agent, input method and actual results in `docs/verification.md`.
The console test must cover character creation, walking in town, entering the
dungeon, fighting, using a potion, inventory, saving and reloading, then ten
minutes without crashes or stuck input. Report measured frame rate separately
from the 20 Hz target. Audio scheduling is not proof that sound was audible.

Once that passes, extend the landing page with the supplied games and local
icons. Each exact build gets its own verified/untested/requirements-missing/
unavailable status. External games open as top-level pages. Recheck all links:
Moon/Kino/Cheese Cube previously redirected elsewhere, and `ut.pieter.com` was
Urban Terror. None is automatically declared Switch-compatible.

Attribution and preserved upstream notices are in `third_party/`.
