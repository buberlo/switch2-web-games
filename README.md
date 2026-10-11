# Switch 2 Web Games

An experimental toolkit for running web games in the Nintendo Switch 2 browser:
a local captive-portal enabler, game hosting, compatibility probes, controls,
saving and performance measurements. The long-term ambition is to support games
as demanding as GTA V; no specific commercial game is the target.

Diablo shareware is the first implementation. It runs on the console as
JavaScript; the Mac serves files and stores saves. A tested WebGL palette
renderer is available for supporting browsers, with a Canvas 2D fallback.
The measured Switch applet returns no WebGL context and uses Canvas.

**Current physical result:** the preceding build reached approximately 20 FPS
in the menu and 8.4–12.3 FPS in town. The new dungeon optimization and experimental
native BMP renderer passed local correctness and gameplay tests; their Switch
performance is pending. Dungeon gameplay and a ten-minute session are not qualified.

The broader game library follows that physical acceptance gate. See the
[roadmap](docs/roadmap.md), [verification record](docs/verification.md) and
[contribution guide](CONTRIBUTING.md). This is a local LAN project; publishing
the source does not host a public game service.

An isolated [WebGL research harness](docs/research/webgl.md) compares context
creation, pixel rendering and recovery across captive, LAN and public HTTPS
origins. Its stock Switch 2 measurements are pending; it does not change the
game's renderer defaults. Firmware **23.0.1** is owner-confirmed. The
[source investigation](docs/research/webgl-source.md) separates Nintendo evidence
from upstream WebKit reference code.

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
python3 scripts/build_webgl_probe.py
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
avoid repeated terrain decoding. The latest appended patch extends the cache
to resolved solid, unlit or prelit dungeon tiles; masked, translated-light and
fully dark tiles retain the original path. No GPU feature is assumed from API
presence alone.

`/play/diablo?renderer=bmp` selects an experimental native image decoder.
It packs the retained indexed framebuffer and palette into an uncompressed
8-bit BMP using bulk copies, then presents it through Blob → Image → Canvas.
An actual pixel probe checks every palette entry, row orientation and odd-width
padding, trying top-down rows before bottom-up compatibility. A decode failure
or one-second timeout presents the retained frame with Canvas and disables BMP
for that session. `?renderer=canvas` selects the comparison control. The default
still uses verified WebGL where available, otherwise Canvas. Native image
decoding is not evidence of GPU acceleration.

The display adapter allows one transferable frame in transit, combining dirty
rectangles while the page is busy. It counts frames and returns transferred
buffers only after asynchronous presentation completes. Silent hosts skip
unused audio file decoding.
Character loading displays an overlay, measures the synchronous input callback,
and discards stale presses queued during loading while preserving releases.
Actual Switch performance of this revision remains to be measured. Comparison
builds support `--with-intro`, `--legacy-blit`, `--legacy-terrain`,
`--legacy-dungeon-terrain`, and `--legacy-memory`. The dungeon comparison flag
retains the town cache. Matched local interpreter runs reduced median dungeon
render time by 24–32%; those CPU results do not predict Switch FPS.

Preserve comparison builds outside Git before replacing the served engine:

```sh
python3 scripts/build_engine.py --legacy-dungeon-terrain --output data/comparison/baseline.js
python3 scripts/build_engine.py --output data/comparison/candidate.js
```

Each output has adjacent `.build.json` metadata. Keep the served engine and its
`build.json` together when rolling back, then regenerate the runtime identity.

To fetch an updated build on an already running console, return to **Library**
and choose **Play Diablo**, then start it. If the applet has closed, run
**Connection Test** again. The server sends assets with `Cache-Control: no-store`;
frontend and engine updates do not require restarting the LAN services.
The default engine build generates `web/assets/runtime.json` with separate
engine, frontend and combined revision hashes. After editing frontend files,
run `python3 scripts/build_runtime.py`; `--check` rejects a stale identity.
A welcome page left open across a revision change must be reloaded before Start.

**Switch speed test** on the Library opens `/play/diablo?benchmark=1`. It starts
automatically, measures the menu, creates a temporary warrior, and measures
stationary and moving town sequences.
Keep the page visible and leave its controls still. This mode neither reads nor
writes the normal save profile and disables audio. It polls the combined runtime
identity and repeats after an engine or frontend update, once loading has finished.
The Mac records engine, encoding, decoding, presentation and input-delay timings
separately, alongside actual renderer capabilities.

**Compare Canvas and BMP** opens `/play/diablo?benchmark=1&compare=renderers`.
Leave it visible without controls for about 6–8 minutes. It runs three ordered
Canvas/BMP pairs with fresh temporary warriors, six seconds of menu, twenty
seconds stationary and twenty seconds walking in each run. Walking uses ten
fixed deadlines; excessively late commands invalidate the run. A failed native
probe stops the comparison and reports the reason. No comparison automatically
changes the default. These probes do not replace physical gameplay acceptance.

Run local checks:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node scripts/check_engine.cjs
node scripts/check_engine.cjs --scene town-reload --indexed --no-audio --frame-digests
node tests/test_frame_protocol.cjs
node tests/test_input_protocol.cjs
node tests/test_presentation_protocol.cjs
```

For browser checks, install Node.js 22+ and Google Chrome, then install the
pinned development dependencies. Run browser suites one at a time because they
use fixed local test ports. `PLAYWRIGHT_MODULE` can override the module location:

```sh
npm ci
node tests/browser_smoke.cjs
node tests/test_diagnostics.cjs
node tests/test_renderer.cjs
node tests/test_native_renderer.cjs
node tests/test_benchmark.cjs
SMOKE_GPU=1 node tests/browser_smoke.cjs
SMOKE_BMP=1 node tests/browser_smoke.cjs
```

The gameplay browser test uses a temporary profile, checks creation, movement,
inventory, save/reload and the main-thread fallback with WebAssembly/WebGL
disabled, and writes screenshots/results into `data/qa/`. It does not overwrite
your normal saves. The diagnostics suite tests actual drawing/API execution,
input reporting and failure recovery. Renderer tests compare actual GPU and
Canvas pixels, including palette changes and context loss. Native tests check
pixel decoding, mixed formats, timeout/error fallback, cancellation and URL
cleanup. The benchmark suite checks automatic character creation, fixed walking
inputs, paired ordering, frontend-only reload, and an unchanged save profile.
Network/socket permission is needed for
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
