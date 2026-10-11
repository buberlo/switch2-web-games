# Roadmap

Build an open toolkit for running web games in the Nintendo Switch browser,
progressing toward games as demanding as GTA V. This describes an ambition
about game complexity, not a claim that a specific title runs today.

## Current foundation

- Private LAN captive portal with selective Nintendo DNS overrides, ordinary
  forwarding, GET/HEAD redirects, process ownership checks and rollback.
- Browser probes based on actual rendering, messaging, audio and input events.
- Pinned JavaScript-only Diablo shareware build, Canvas fallback, optional tested
  WebGL palette renderer, touch/cursor controls and Mac-hosted saves.
- Exact-build telemetry and an isolated automatic menu/town speed test.

The measured Switch applet lacks WebAssembly and returns no WebGL 1/2 context
(including the legacy WebGL alias). Its Canvas and classic Worker paths work.
Do not extrapolate this result to every Switch browser or firmware. Current
physical and local results are in [verification.md](verification.md).

## Next milestones

1. Finish Diablo performance qualification and real physical gameplay: town,
   dungeon, fighting, potion, inventory, save/reload and ten uninterrupted minutes.
   Improve dungeon lighting/mask rendering and Canvas conversion with exact
   pixel checks and bounded caches.
2. Add the icon library and a game registry. Each exact build gets its own
   verified, untested, requirements-missing or unavailable status. Recheck links,
   navigate external games at the top level, and preserve launcher selection.
3. Separate game adapters from the portal: capability requirements, controls,
   progress/failure recovery, asset manifests, profiles and measurements.
4. Support more demanding engines through measured CPU, memory and rendering
   improvements. Investigate 3D software rendering and available acceleration
   only where actual device execution proves support; add reproducible stress
   scenes before declaring compatibility.
5. Establish budgets for large worlds, textures, animation, physics, loading,
   audio and save data. Expand to richer games as each bottleneck is resolved.

There is no promised date or supported demanding 3D title yet. Keep working
features, experiments and physical acceptance separate in release notes.
