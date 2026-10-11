# Contributing

The aim is to make increasingly demanding games run in the Nintendo Switch 2
browser. Games with the complexity and resource demands of GTA V are a useful
long-term benchmark; no particular commercial game is the project target.

Start with the [README](README.md), [roadmap](docs/roadmap.md) and
[current evidence](docs/verification.md). The captive service setup is currently
tested on macOS; browser support belongs to an exact console, applet and game
build. Contributions to other hosts or console versions need their own results.

Small improvements with reproducible measurements are useful: game adapters,
software rendering, native array operations, compatibility probes, memory
budgets, controls, saving, and documented browser capabilities. Include the
engine/source revision, compiler flags, scene, input method, elapsed time and
actual presented FPS. Compare the same scene with one change at a time.

Desktop tests and simulated interpretation are development evidence. Call a
game Switch verified only after physical character/gameplay tests, save/reload,
and ten minutes without crashes or stuck input. Keep unknown, unavailable and
failed features explicit. A menu or API constructor alone is insufficient.

Use local builds and tests. GitHub Actions are disabled for this project;
do not add workflows. Python tests use temporary high-port services, and browser
tests use isolated save profiles. Avoid running two browser suites at once
because they use fixed local test ports.

Do not commit game archives, personal saves, runtime logs, credentials, compiler
downloads, vendor trees or generated engines. Asset setup must identify the
source, pin a checksum and preserve its notices. Use shareware or game files the
player supplies. Preserve third-party license terms when changing engine patches.

Before changing an existing privileged portal service, inspect its ownership.
The rig refuses unrelated processes. Keep rollback working; do not introduce
system-wide firewall changes or HTTPS interception.
