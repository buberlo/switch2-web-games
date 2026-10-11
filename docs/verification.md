# Diablo-first verification record

Date: 2026-10-11. Physical Switch acceptance is **pending**. The icon library
remains gated on the complete physical play session below.

## Exact build

| Item | Value |
| --- | --- |
| Engine | d07RiV/Devilution, `DiabloSpawn` |
| Source revision | `798b5122731ae4b5e0c91348e5c44cf79354a94e` |
| Compiler | Emscripten 3.1.74 |
| Output | JavaScript, full wrapper transpiled and Acorn-checked as ES5 |
| Engine file size | 2,044,825 bytes |
| Engine SHA-256 | `ef1a9cd3ac35b35941b62d069d5dbd6d62574756cf3e6ca8771d746c3c8cc37e` |
| Source adaptations | Skip startup movies; native memory copies/fills; cached UI and town tile spans; indexed output; silent audio loading; complete loading and exit phase hooks |
| Initial / maximum heap | 128 / 256 MiB; archive and browser buffers are additional |
| Shareware archive | `spawn.mpq`, 25,830,791 bytes, `MPQ\x1a` signature |
| Archive SHA-256 | `21d125650291d6099a4a49e325374add8fbc3ac17f97d64fac83bbdd3364f28f` |
| Rendering | Tested indexed WebGL palette renderer, otherwise Canvas 2D; 640×480, dirty rectangles, CSS scaling |
| Simulation target | Original 20 Hz loop |

Full generated provenance and source patch hashes are in `web/engine/build.json`.
Engine output and game data are ignored by Git and reproducible with the setup
commands in the README. The exact optimized build above awaits physical retest;
earlier console runs used the hashes recorded below.

## Local results

- The publication snapshot passed 46 Python tests, and the current engine plus
  Canvas renderer passed the complete desktop gameplay/save/reload suite in
  both Worker and main-thread modes. The optional GPU rendering path passed
  that suite separately. Neither desktop run qualifies physical Switch speed.
- The current compiled engine produced 120 valid indexed menu frames in
  both worker-shaped and main-thread-shaped VM tests. WebAssembly, BigInt,
  SharedArrayBuffer, Worker, OffscreenCanvas and IndexedDB were absent from those
  VM environments. This checks engine execution, not physical gameplay.
- Chrome 154.0.8037.99 gameplay reached character creation and town with WebAssembly disabled
  in both the page and classic Worker, WebGL disabled in the page, and
  TextDecoder/SharedArrayBuffer unavailable. No `.wasm` requests occurred. The
  Worker adapter does not use WebGL or create any canvas.
- A character was created, a scaled canvas click was delivered, inventory was
  opened, and a real shareware save was written to an isolated Mac profile.
  Reloading the same character through the main-thread fallback returned to town.
- At an 864.65625×648.484375 CSS display size, the actual Worker mouse messages
  delivered the expected `(400, 280)` game coordinates for press and release.
  Aborting the archive request produced a visible error with zero rendered
  frames. The displayed Reload game action recovered to 37 frames without error.
- Steady desktop town samples were approximately 20 rendered batches/second.
  Loading transitions produced higher short samples because the engine can draw
  repeatedly during transitions. These measurements are engine render batches,
  not display refresh rate or Switch performance.
- Capability diagnostics exercised actual Canvas pixels, WebGL drawing,
  WebAssembly execution and classic Worker messaging. They also ran with
  WebAssembly/WebGL/browser storage disabled. Audio scheduling succeeded in
  desktop automation; audible output still requires human confirmation.
- Diagnostics record actual observed input events and allow report retry after
  a failed write. API presence alone is not reported as a successful input test.
- Python tests cover connection-check GET/HEAD redirects, proper missing-asset
  errors, MPQ range responses, authenticated and bounded atomic saves, invalid
  paths/origins, selective DNS forwarding with real dnsmasq on isolated high
  ports, process identity checks, privilege-drop ordering and mocked lifecycle
  rollback. The initial thirty tests passed. The first privileged handoff was
  attempted and failed as recorded below; physical gameplay remains pending.
- After the recovery fix, the full Python suite passed **45 tests in 6.454
  seconds**, including real dnsmasq beside a compatible dual-stack IPv6 wildcard
  listener on macOS, correct TCP/UDP captive responses, and external forwarding.
  Fault tests cover stale restored PIDs, process exit before readiness, PID-file
  write failure, foreign exact-address listeners, and ordered recovery/retry.
- The previous `f834…` engine passed the gameplay browser suite. Its
  metadata matched the actual downloaded engine bytes; four metadata requests
  returned 200 and twelve persisted game reports identified the exact engine
  hash and `bounded-rgba-v1` across Worker and main-thread execution. Direct-menu
  startup, town, inventory, scaled inputs, save/restore and loading recovery
  passed with no runtime errors or `.wasm` requests. Steady presented town rates
  were 19.92 FPS in Worker mode and 20.00 FPS in the main-thread fallback. These
  remain desktop results. The test's temporary server stopped automatically;
  the production LAN services were kept running.

Reproducible checks:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
node scripts/check_engine.cjs
node tests/test_frame_protocol.cjs
node tests/test_input_protocol.cjs
node tests/browser_smoke.cjs
node tests/test_diagnostics.cjs
node tests/test_renderer.cjs
node tests/test_benchmark.cjs
SMOKE_GPU=1 node tests/browser_smoke.cjs
```

Browser tests require Playwright and Google Chrome; see the README for module
path options. Gameplay test saves are temporary and do not change the normal
profile. Local evidence is retained in ignored `data/qa/` (JSON plus screenshots)
and `.toolchain/engine-smoke-result.json`.

## Console handoff and measured limits

The research HTTP/DNS service identities were inspected before handoff. The Mac
was `192.168.0.104`, with router/upstream `192.168.0.1`. Root HTTP on port 80 and
DNS on port 53 belonged to the referenced `switch2-research` project. Its files
and 8080/443 services remain separate. The new rig changes only verified owned
processes, and retains the original commands for rollback.

At preparation time, `sudo -n true` returned that a password was required. The
user therefore performed the console-facing handoff in Terminal as recorded
below. This is an operating-system credential boundary. No password is
requested or stored by this project.

### First privileged handoff

At 13:47 local time, the user ran the documented cutover command. It stopped the
original direct services, then reported `TCP 192.168.0.104:53 is unavailable:
[Errno 48] Address already in use`. Automatic rollback restored research HTTP,
but the same port check prevented DNS restoration.

Subsequent read-only inspection found Colima's `limactl hostagent` PID 75704
listening on wildcard IPv6 TCP port 53. The original HTTP
portal was confirmed back on port 80 with its 302 redirect; the direct research
DNS process was absent. Research source files and unrelated Colima services were
not modified. The saved root-private handoff remains available for recovery.

The rig's original probe omitted `SO_REUSEADDR`, unlike its actual servers, and
performed the check only after stopping research. An isolated high-port macOS
reproduction confirmed that a specific IPv4 TCP bind/listen fails beside a
dual-stack wildcard without that option and succeeds with it. This establishes
the false rejection mechanism without changing Colima or privileged listeners.

The recovery command is `sudo /usr/bin/python3 scripts/rig.py retry-cutover
--apply`. It completes the saved rollback before attempting a new cutover.
The repaired probe uses socket reuse plus an actual TCP listen, and refuses
shared exact-address TCP/UDP endpoints. Cutover checks foreign listeners before
stopping research. Start and rollback verify owned sockets before success;
restore journaling precedes research PID-file writes. The real Colima listener
was successfully parsed by the new read-only inventory.
The isolated tests established the repair. The subsequent low-port DNS recovery
and console delivery are recorded below.

### Live recovery and first console run

At 14:06 local time, the user ran `retry-cutover --apply` successfully. The live
HTTP process was PID 36077 under user `konrad` after dropping privileges; DNS
was PID 36082 under `nobody`. `/healthz` identified this project, and both engine
and shareware data were ready. Live UDP and TCP captive A queries returned
`192.168.0.104`; captive AAAA returned NOERROR with zero answers. `github.com`
resolved externally as `20.205.243.166` through the upstream router.

The Switch at `192.168.0.106` requested the new portal and engine, posted loaded
and first-frame events in Worker mode, and continued receiving 302 responses
to its periodic connection checks. Audio initialization reported unavailable.
The user confirmed that Diablo opened and accepted input, then clarified that
the Blizzard intro movie was extremely slow and gameplay had not been tested.
This is a physical execution success with a performance blocker, not playable
gameplay acceptance. That run used engine SHA-256
`7c3e870af230860f9da800cfe3acc91624335c5fca01fcab9d93d2885866555d`,
2,049,417 bytes. It ended before the old metrics interval submitted timing data.

### First performance revision — historical `f834…` build

That build bypasses startup videos and the title screen before creating
the Smacker decoder; it opens the main menu directly. This avoids both the
movie's initial audio decoding and per-frame video decoding. Opaque menu art
now uses native typed-array row copies, and palette conversion writes each RGBA
pixel through a JavaScript 32-bit array. Masked sprites and fonts keep the
original path. The patches remain independently reversible through build flags.

The host adapter now retains one framebuffer and reuses one transferable output
buffer. It sends only one frame at a time, merges pending dirty rectangles, and
waits for an acknowledgement after Canvas drawing. The page uses an ImageData
view over the received buffer when supported, with a persistent-image fallback.
Disabled audio callbacks are no longer forwarded to the page. A protocol test
uses real buffer detachment to verify both execution modes, delayed/stale
acknowledgements, dirty-pixel preservation and text-only frames.

With Node JavaScript JIT disabled, paired 120-frame menu tests measured mean
render time falling from 80.1 to 25.5 ms in Worker-shaped execution and from
73.1 to 24.5 ms in main-thread-shaped execution. Both builds produced the same
RGBA SHA-256, `964d8077b1d0c1ad53e88199edaf59e91985524815045979c1205ffd47638589`.
Town, inventory and click sequences also matched the baseline byte for byte,
including the optional offscreen rendering stride. These are controlled local
engine comparisons; they do not establish the Switch's JIT policy or frame rate.
The paired menu means count all 120 synchronous calls and include RGBA hashing;
initialization and browser paint/transfer costs are excluded. Interpreter town
calls 31–120 averaged 42.4 ms in Worker-shaped execution (p95 79 ms) and 27.0 ms
in main-thread-shaped execution (p95 36.1 ms). Worker spikes exceeded the 50 ms
budget, so the local interpreter run does not establish consistently sustained
20 Hz. Exact timings and byte-equivalence reports are retained under
`data/qa/engine-performance/`; the current engine smoke report is also refreshed.

Desktop browser profiles of the adapter showed main rendering time fall from
0.200 to 0.106 ms without CPU throttling, and from 2.203 to 0.714 ms with 12×
page CPU throttling. Both town samples stayed near 20 FPS. Chrome cannot apply
this throttle to Workers, so those profiles measure page overhead only. Evidence
is in `data/qa/performance-baseline/` and `data/qa/performance-direct-menu-bounded/`.

The running LAN HTTP service was checked after the revision and served the exact
then-current `f834…` engine hash, both new scripts and `Cache-Control: no-store`.
Its PID and health instance were unchanged. A fresh Play Diablo page loads the
revision without a service restart. Reports now include the engine hash,
`bounded-rgba-v1` protocol, presented FPS, engine rate, tick/bridge/Canvas time,
delivery lag and coalesced-frame count, with early samples to diagnose slow runs.

### Second physical run: measured engine bottleneck

At 15:38 local time (07:38 UTC), the Switch ran `f834d99…fbcf5e`. The user
reported a 5 FPS menu, followed by a freeze and black screen after entering the
character name. Early reports measured 5.27–5.72 presented FPS, approximately
188.5–188.8 ms per engine tick, 0.09–0.64 ms of bridge work, and 1.10–1.45 ms
of Canvas drawing. There were initially no coalesced frames. This attributes
the steady menu limit to engine CPU work rather than Canvas delivery.

Character acceptance loads the level synchronously inside an input callback;
the old tick metric excluded that time. `ShowProgress` emits a black frame
before preparing the level. During loading, the worker cannot handle its frame
acknowledgement, so later loading frames remain pending. The final report had
44 coalesced frames, followed by an explicit engine exit at 07:39:21.775 UTC.
The exit callback indicates a null game state, with known paths through menu
Escape/Exit or in-game Quit; the old input history cannot establish which path
occurred. No fatal-error or failed-save event was recorded.

All observed save PUTs returned 200. A read-only snapshot of the actual saved
hero restored with the same engine in two isolated interpreter tests, produced
160 frames and emitted no errors or exits. New-character acceptance locally
blocked for 3.23–3.83 seconds and produced 40 frames in that single input call.
These local durations are not Switch timings. Evidence is retained under
`data/qa/loading-analysis/`. This physical build failed performance acceptance;
the next revision must be measured separately.

### Indexed revision — `b431…`

The `b43159…` engine moves palette expansion out of the engine and sends strided
indexed pixels. Cached masked UI spans and native memory copies/fills reduce
interpreted loops. An actual shader readback and WebGL-to-Canvas copy test select
the GPU palette renderer; API presence alone is insufficient. Canvas fallback
converts changed eight-row strips and retains unchanged pixels. Context loss
switches back to Canvas. Silent hosts skip unused audio decoding.

The host preserves bounded, acknowledged frame delivery and records actual
presented FPS, engine tick time, input callback time, indexed bridge cost,
conversion/cache cost, and native memory capability. Character acceptance blocks
new controls behind a visible loading overlay. Timestamped stale presses are
discarded after synchronous loading; releases are always accepted. Exit reports
include the engine's explicit reason and bounded recent input history.

Fresh paired Node `--jitless` menu tests used the same harness and warm calls
31–120. Complete CPU test-pipeline mean fell from 24.3 to 11.9 ms in the
main-thread-shaped VM. Engine-only mean fell from 23.7 to 0.6 ms, but the current
test consumer separately reconstructs and hashes RGBA (about 11.3 ms). The
engine-only result is therefore not an end-to-end FPS improvement. Both menu
pixel digests matched. Indexed town mean was 13.5 ms, median 13.4 ms and p95
14.4 ms; approximately 84% of sampled engine work was terrain rendering. Native
copy/fill methods removed, RGBA compatibility, offscreen clipping, town input,
and save digests also passed. These are local interpreter measurements, not
evidence of the console's JIT policy or speed. Evidence is under
`data/qa/engine-performance/indexed/`.

The current engine passed full Chrome gameplay tests with WebAssembly and
WebGL disabled, and a separate run with the tested GPU renderer enabled.
Canvas Worker town measured 19.95 presented FPS and main-thread town 20.00 FPS;
GPU town remained around 20 FPS. Real pixel comparisons cover all palette
entries, strided rectangles, palette changes, mixed RGBA/indexed frames, detached
buffers and context loss. Desktop checks also exercised the name-loading
overlay, blocked controls, and release after actual engine readiness. No `.wasm`
requests or runtime errors occurred. Normal saves were untouched. Artifacts are
in `data/qa/browser-smoke.json`, `data/qa/gpu-smoke/` and `data/qa/renderer/`.

The Library's **Switch speed test** uses an opt-in temporary character, reads no
normal saves and suppresses all persistent save operations. It measures six
seconds of menu frames and twenty seconds in town, records the exact engine
hash and actual renderer capabilities, then stays in town. It checks for new
engine metadata and reruns after a safe reload so later builds can be measured
from the same open applet. This is a short performance probe, not ten-minute
gameplay acceptance. Its physical results are recorded below.

The isolated benchmark integration test passed two complete desktop runs, with
one metadata-only change triggering exactly one automatic reload. Normal mode
remained inactive. Both benchmark runs passed empty saves to the real Worker,
made zero save API requests, and preserved every sentinel profile byte and
filename. Desktop menu measured 20.14 FPS and town 20.02 FPS; these prove the
measurement flow, not physical Switch speed. Reports and screenshots are under
`data/qa/benchmark-browser/`.

### Third physical run — `b431…` speed test

Two complete automated Switch runs measured menu 16.67 / 16.47 FPS over
6.18 / 6.13 seconds, and town 9.91 / 10.24 FPS over 20.19 / 20.42 seconds.
Character creation finished in approximately 8.3 seconds, reached
`game-ready(level 0)`, and emitted no error or exit. This resolves the previous
black-screen failure in those temporary-character runs, not all manual input
paths. Steady menu engine ticks were about 11.5 ms; Canvas cost about 36 ms
(roughly 28 ms conversion and 6.7 ms signatures). Town engine ticks were about
101 ms and Canvas about 18 ms, identifying the next terrain bottleneck.

Both WebGL context versions, including the experimental WebGL 1 alias, returned
no context. Canvas pixel readback and native typed-array copy/fill tests passed.
The classic Worker ran at a 128 MiB heap. No persistent saves were read or
written by the speed test. These stationary probes do not qualify dungeon
traversal, combat, potion use or ten-minute gameplay. Evidence is retained in
`data/qa/physical-b431.json`.

### Current revision — `ef1a…` town cache and adaptive Canvas

Native town tile spans reduced paired no-JIT core mean from 12.9 to 4.7 ms and
median from 12.9 to 4.1 ms. All 283 frames matched through zoom, movement,
inventory, save and reload in both execution contexts. Older-build full saves
also restored identically. Serialized animation pointer addresses make full
save bytes vary between engine layouts; all other plaintext save fields matched.
The cache is capped at 2,048 entries and 2 MiB of span buffers, with resets on
level graphics loading and teardown. Dungeon rendering retains its existing
path. The in-game Load action now emits loading-start and final game-ready.

Adaptive Canvas conversion reduced recorded menu time by 37% and town time by
23% in the local interpreter browser benchmark; fully changed frames cost
approximately the same. Its 641×49 pixel suite covers odd/strided updates,
palettes, mixed RGBA/indexed frames, text, detached buffers and GPU context loss.
The final engine also passed the complete desktop Canvas and WebGL gameplay
suites, including the separate in-game Load path and page/main-thread restore.
The WebGL test can use Chrome's software driver; it is API/pixel correctness
evidence, not proof of hardware acceleration. Current-build physical FPS is
pending. Evidence is under `data/qa/engine-performance/terrain/`,
`data/qa/renderer-prototype/` and the browser smoke artifacts.

Existing research logs established prior portal delivery and reported missing
WebAssembly for this applet user agent:

```text
Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/613.0 (KHTML, like Gecko) NF/7.0.3.12.11 NintendoBrowser/5.2.0.55481
```

The initial Diablo run confirms Worker execution and first-frame rendering on
the console. Performance and controls for the revised build still require
physical testing, and Joy-Con exposure is unverified. A `maxTouchPoints` value
of zero alone does not establish that touch is unavailable.

## Physical acceptance — not yet performed

Record the exact engine hash above, console firmware/applet UA, input method,
start/end time, observed actions, crashes/stuck inputs, and actual frame samples.
Use `/diagnostics` first, then `/play/diablo`; the Mac records reports in
`data/diagnostics.jsonl`. The game submits frame/input/heap samples roughly every
two seconds for its first three samples and every fifteen seconds thereafter.
If the Worker fails, retry with `?main=1`; a change of
execution mode must be recorded separately.

| Required action | Result |
| --- | --- |
| Connection Test opens the new portal | Confirmed by console requests and user |
| Play Diablo renders and accepts input | Earlier builds rendered; `f834…` menu approximately 5 FPS; current build pending |
| Create character | Two b431 temporary warriors reached town; latest build pending |
| Walk through town | Pending |
| Enter dungeon | Pending |
| Fight an enemy | Pending |
| Use a potion | Pending |
| Open inventory | Pending |
| Save, reload and resume the same character | Pending |
| Ten-minute physical session without crash or stuck input | Pending |
| Achieved frame rate against 20 Hz target | `b431…` menu 16.47–16.67 FPS, town 9.91–10.24 FPS; latest build pending |
| Sound actually audible | Unconfirmed |

A title screen or menu is not gameplay acceptance. If execution or input fails,
record the exact visible error and received diagnostics before adding more
games. The expanded icon catalog has deliberately not been built yet.
