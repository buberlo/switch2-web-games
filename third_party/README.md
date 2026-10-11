# Diablo shareware engine and assets

This local setup uses the Diablo shareware engine adapted by d07RiV
from the Devilution reconstruction. Diablo and its game data belong to Blizzard.
This project is unofficial and is not affiliated with Blizzard.

The engine source is pinned to `d07RiV/devilution` commit
`798b5122731ae4b5e0c91348e5c44cf79354a94e`. Its `LICENSE` contains the Unlicense;
its README additionally states that use of the source and derivatives must be
noncommercial. Both notices are retained here rather than describing the
combined source as unconditionally unrestricted. Embedded third-party source
notices (including zlib, pklib and libsmacker) remain in the downloaded tree.

The host interface is documented by `d07RiV/diabloweb` commit
`c61ef19c54ea646aed328bd8cc82c8a5f1ebd81d`. The new local host uses that engine
interface directly; it does not require the original React client or the newer
JohnImril React/TypeScript shell.

`scripts/build_engine.py` fetches the pinned source and Emscripten 3.1.74,
verifies archive hashes, and builds DiabloSpawn as JavaScript with Wasm2JS.
Generated code, compiler downloads and vendor source are local build products.
`web/engine/build.json` records the engine output hash and build settings.
Tracked patches in `third_party/patches` are applied reproducibly to that pinned
tree. The default `SWITCH_SKIP_INTRO` build opens the main menu before creating
the startup video decoder or title screen; this avoids expensive interpreted
Smacker decoding in the captive browser. Build with `--with-intro` to preserve
the upstream startup sequence. This does not remove videos from the archive.
The default `SWITCH_FAST_BLIT` path copies opaque UI image rows with native
typed-array operations. Immutable masked UI fonts/logos cache opaque spans,
bounded to 512 frame/clip combinations; negative coordinates retain upstream
clipping. The cache stores integer offsets rather than heap views, so memory
growth does not leave stale views. Background art is unmasked and never cached.
The UI fonts/logos stay allocated across game/menu transitions.

An optional synchronous host `draw_indexed(x,y,w,h,indices,stride,paletteRGBX)`
receives borrowed indexed pixels and the current 256-entry palette. The host
must copy the strided rows before returning and force palette alpha to 255.
Without that callback, or with the engine's offscreen flag, the original RGBA
interface remains available. `--legacy-blit` restores original per-pixel loops
for comparison. Optional `profiler(name,ms)` and `phase(name,details)` callbacks
expose rendering costs, loading progress and explicit exit requests. A host
`sound_enabled()` returning false skips unused audio archive loads.

The default `-mbulk-memory` build lowers copies/fills to native typed-array
operations while still emitting JavaScript only. The included compatibility
code provides `Uint8Array.copyWithin`/`fill` fallbacks using native `set` when
those methods are absent. `--legacy-memory` restores compiled memory loops;
`--output PATH` writes a comparison artifact without replacing the served one.

The default `SWITCH_FAST_TERRAIN` path caches decoded spans and copies their
rows with native typed arrays. `SWITCH_FAST_DUNGEON_TERRAIN` extends eligibility
after the upstream renderer resolves the source and transparency mask: only
solid-mask, untranslated, non-dark spans are cached. This includes unlit town
tiles and already-prelit dungeon speed-cels. Masked, table-translated and fully
dark terrain keeps the upstream renderer. Original row clipping and drawing
order are preserved. Black town diamonds use native row fills with the same
upper/lower clipping conditions; dungeon black fills are unchanged.
`--legacy-dungeon-terrain` restores the prior town-only optimization for a
matched comparison, while `--legacy-terrain` restores all original terrain
paths. Build metadata records both selections. The cache holds integer offsets, not heap
views or pixel copies, and resets in both `FreeGameMem` and `LoadLvlGFX`, so a
reused allocation address cannot refer to an earlier level. It is limited to
2,048 entries and 2 MiB of span buffers; the extended town test uses 573 entries
and 240,252 bytes across all six tile shapes. Entry bookkeeping is additional
small JavaScript object storage. An appended load-menu patch sends matching
`loading-start`/`game-ready` phases around direct in-game save reloads.

`scripts/check_engine.cjs` checks the actual generated engine without WebAssembly
in worker-shaped and main-thread-shaped Node VMs. Its default scene is the
direct menu. `--scene town` creates a shareware hero in memory, enters town,
opens/closes inventory and sends a movement click; `--offscreen` exercises the
full-frame destination stride. `--engine PATH` selects a saved baseline build,
and `--with-intro` exercises an optional upstream-startup build. `--indexed`
checks the strided indexed API by reconstructing its RGBA output; `--no-audio`
checks silent loading, and `--without-memory-builtins` verifies compatibility
with native copy/fill methods removed. `--profile` collects optional engine
timings. Reports include
every RGBA buffer's cumulative SHA-256 and measured render-call times; the
browser clock is fixed for repeatable dungeon setup. Running Node with
`--jitless` simulates interpretation for CPU comparisons, not physical Switch
performance. Preserve a `--legacy-blit --legacy-memory` build to compare its
pixel hashes and timings with the default build. `warmEngineTimingMs` excludes
the test consumer's RGBA reconstruction/hash work; `renderTimingMs` includes it.
Both exclude browser rendering/audio. The town scene also records synchronous
hero-accept time and save-file digests without writing to the real profile.
`--scene town-reload` adds both zoom modes, a full game save/load, the character
panel and another movement click. `--frame-digests` records every rendered
frame's geometry and pixel digest. `--save-dir PATH` exports these synthetic
saves, and `--reload-save PATH` substitutes an older build's archive before
the reload to verify compatibility. Cache bounds and reload invalidation are
checked when the optimized cache is present.

`--scene dungeon-reload --reload-save PATH` loads a local cathedral-level save
through ordinary in-game Load, then exercises both zoom modes, inventory,
character panels, two walking inputs, and a second save/load. It requires
`game-ready(value=1)` after each load and verifies cache invalidation. The
`dungeonWarmEngineTimingMs` measurement covers 120 stationary calls after 30
warmup calls following the first load. This scene uses only production inputs;
all checks reject unexpected engine `DApi` exports, including private debug or
level-entry helpers. Use a synthetic or disposable save and keep it outside
Git. Loading such a fixture does not prove ordinary dungeon entrance traversal
or physical-console playability. Compare baseline and candidate using the same
fixture, fixed browser clock and `--frame-digests`; old save archives can then
be cross-loaded to verify compatibility. Run timing comparisons sequentially
without concurrent builds. No desktop interpreter timing predicts Switch FPS.

The original full-game serializer copies player animation pointers into its
payload. Therefore rebuilding with a different memory layout can change a
full-save archive's bytes without changing game state. A private instrumented
terrain comparison found only 17 such pointer words different; all other plaintext save bytes
matched. Reloading the baseline archive in the optimized build produced
identical frames. Hero-only saves in the basic town scenario remain byte
identical. Do not describe full-save byte equality as a cross-build guarantee.

`scripts/setup_assets.py` fetches only the shareware `spawn.mpq` from the
original DiabloWeb project's pinned `gh-pages` revision
`6e187315aec6bd7c0b53275ef0228718a789ecff`, verifies its MPQ signature,
25,830,791-byte length and SHA-256
`21d125650291d6099a4a49e325374add8fbc3ac17f97d64fac83bbdd3364f28f`.
The source project's README identifies this as its shareware archive.
No retail `DIABDAT.MPQ` is downloaded or included. Keep game data and saves out
of source control and public deployment.

Sources:

- https://github.com/d07RiV/devilution
- https://github.com/d07RiV/diabloweb
- https://github.com/diasurgical/devilution
- https://github.com/emscripten-core/emscripten/tree/3.1.74
