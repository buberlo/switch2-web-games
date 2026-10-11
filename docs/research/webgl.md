# Stock Switch 2 WebGL research

This experiment asks whether the stock Switch 2 applet exposes a usable WebGL
context. It does not change Diablo's renderer selection, captive DNS, firmware,
or the physical gameplay acceptance gate.

## Current evidence

- System version **23.0.1** was reconfirmed by the owner on 2026-10-12. Each new
  report requires confirmation and a handheld/docked selection.
- Five earlier engine-startup reports returned no WebGL context. They are not
  controlled fresh-applet comparisons. See the exact UA, sanitized measurements,
  provenance and hypothesis table in [the source investigation](webgl-source.md).
- The new isolated matrix passes desktop positive and fault-injection tests.
  New physical origin comparisons remain pending. Desktop SwiftShader drawing is
  harness validation, not evidence of Switch GPU access or gameplay speed.
- Nintendo's catalog lists Switch 2 sources for 23.0.0 or later. Retrieval is
  blocked by HTTP 403; no corresponding archive bytes or SHA-256 are claimed.
  Pinned upstream source references are explicitly approximate.

## Run without installing Diablo

The Python server has no package dependencies. From a fresh checkout:

```sh
python3 scripts/build_webgl_probe.py
python3 server/portal.py --host 127.0.0.1 --port 8090
```

Open `/assets/webgl-research.html`. The portal also links it from the footer.
Use the [existing captive-service setup](../../README.md#enable-the-switch-captive-portal)
to reach it on the console; no engine compilation or game archive is required.
The observed check hostname is `ctest.p01.ctest.srv.nintendo.net`.

For an already-running rig, regenerate the configuration with the current Mac IP:

```sh
python3 scripts/build_webgl_probe.py --lan-origin http://192.168.0.104
```

The IP above is an example. `--lan-origin` appears only in the generated LAN
configuration, never in the public upload. Static changes require no privileged
service restart. Rebuild after changing any probe source; the displayed SHA-256
identifies the HTML, CSS, core, controller and shared transport bytes together.
Deployment origins are metadata and do not change that source revision.

## Controlled physical procedure

1. Record System Settings → System version, handheld/docked mode and the entry
   route. Close and reopen the stock Wi-Fi login applet through Connection Test.
   Select **First opening**. Do not launch Diablo before these checks.
2. Open **WebGL research**, confirm the metadata and press **Start automatic
   checks**. Leave the page untouched until the gesture button is enabled.
   Automatic cases wait for transient activation to expire when observable;
   an older browser without that API uses a six-second delay and records the
   activation state as unavailable.
3. Use six real taps or browser-cursor clicks on the gesture button. Each context
   request executes synchronously in its trusted click handler. Synthetic clicks
   are rejected. A successful case may animate for two seconds before continuing.
4. Confirm **All 18 checks completed** and **Results saved on your Mac**. A failed
   submission retains the report and exposes a retry button. Completed cases are
   sent throughout the run; a later failure does not discard them.
5. Repeat the identical revision through **Open captive hostname test**, **Open
   direct LAN test**, and **Open HTTPS test**. Use the same physical mode and
   opening number. Ordinary navigation does not establish a different applet.
6. On HTTPS, use **Return results to the Mac**, review the claimed source and
   choose **Save this returned report on the Mac**. The HTTPS page never requests
   a LAN API or obtains a session token. If a destination cannot open, return to
   the local probe and explicitly record that origin as unreachable.
7. Close the applet completely and repeat all reachable origins with **Second
   opening**. A page reload is not a fresh applet opening. Keep raw reports local;
   publish a sanitized table containing revision, firmware, mode, UA, origin class,
   case ID, context outcome, error text and rendering checks.

The full matrix is three names (`webgl`, `experimental-webgl`, `webgl2`) × two
attribute sets (omitted, minimal) × three creation conditions (visible automatic,
detached automatic, visible trusted tap). Minimal disables alpha, antialiasing,
depth, stencil and drawing-buffer preservation, with
`failIfMajorPerformanceCaveat:false`. Every initial request has a fresh canvas
and a creation-error listener; 2D is never requested first. Visible canvases are
scrolled onscreen synchronously before requesting the context, preserving the
trusted event stack. Creation and animation geometry records both viewport
intersection and full visibility; detached creation stays detached.

The report distinguishes API exposure, null context, thrown exception,
creation-error messages, actual attributes and validation failure. It records
origin, protocol, secure context, applet UA, visibility, direct trusted gesture,
observable transient activation, source revision and user-confirmed metadata.
For successful contexts the progression is clear/readback → triangle → exact
256-entry palette plus mixed RGBA and row orientation → visible 640×480 palette
animation → acknowledged context loss → fresh context and readback.
Animation FPS means submitted draws per callback, not verified display
presentation, GPU acceleration or game FPS.

Only one unreleased successful context is allowed. GL resources are deleted and
context loss must be acknowledged before another is created. Missing release,
release timeout or an unreleasable recreated context stops the matrix. Use the
offered real reload link, review the retained cases and reconfirm the metadata to
continue. Retained fragment data is marked untrusted. No browser storage is needed.

Returned reports are bounded to 60 KiB UTF-8; URL transport is limited to 32 KiB.
A larger report stays readable in full and can be copied to the local manual
import field. Nothing is silently truncated. A successful desktop matrix is
larger than the return-link bound, so manual import is part of the tested path.
URL fragments are not sent in HTTP requests, but their contents still require
review; imported reports retain an explicit untrusted provenance marker.

## Publish the static HTTPS control

The direct-upload project is `switch2-webgl-probe`. Deployment status and exact
measurement revision are recorded in [validation](webgl-validation.md).
Public origin: [switch2-webgl-probe.pages.dev](https://switch2-webgl-probe.pages.dev).

Node.js **22 or newer** is required for the pinned Wrangler CLI. Use local npm
dependencies, not a global or automatically upgraded CLI:

```sh
npm ci
npx wrangler whoami
# Only for first setup in your account; log in if whoami requires it:
npx wrangler pages project create switch2-webgl-probe --production-branch main --force
```

Wrangler 4.149.0 otherwise delegates a new project to Workers in agent sessions;
`--force` on **initial creation** selects the explicitly requested direct Pages
project. It does not replace an existing project. Inspect the returned domain,
then substitute that origin and your LAN address below. If using an existing
project, inspect its ownership and skip creation.

```sh
python3 scripts/build_webgl_probe.py \
  --public-origin https://switch2-webgl-probe.pages.dev \
  --lan-origin http://192.168.0.104
python3 scripts/build_webgl_probe.py \
  --public-origin https://switch2-webgl-probe.pages.dev \
  --lan-origin http://192.168.0.104 --check
npx wrangler pages deploy data/webgl-public \
  --project-name switch2-webgl-probe --branch main
node scripts/check_webgl_deployment.cjs https://switch2-webgl-probe.pages.dev
```

Upload **only `data/webgl-public`**. Its ten-file allowlist contains the five
reviewed source assets, public configuration, manifest, entry page, explicit 404
page and static headers. It contains no engine, game archive, save, local log,
credential or LAN address. A clean staged directory replaces the previous bundle;
symlink sources and unexpected upload files are rejected. Check uploaded source
hashes against `manifest.json` and verify game/API paths return 404. Pages may
canonicalize the HTML path to an extensionless URL; the same probe is served.

The preceding upload bundle is retained as `data/webgl-public.previous` and the
preceding LAN config as `data/webgl-local-config.previous.js`. To roll back,
restore the matching source commit, rebuild, recheck and upload its bundle; retain
the previous folder before another build if it is needed. A failed LAN-config
write restores the preceding public directory. The existing rig's stop/rollback
commands remain available and unmodified. No Git integration or Actions is used.

## Local verification and interpretation

```sh
npm ci
npm run test:webgl
python3 scripts/build_runtime.py --check  # when a Diablo engine is installed
```

Browser tests require local Google Chrome (the UI suite accepts `CHROME_PATH`),
Playwright and permission to start local sockets. They use port 8097 for the
controller and synthetic routed pages for the core. They do not operate the
physical console or overwrite its saves. Tests cover enabled and deliberately
disabled WebGL, thrown exceptions, asynchronous creation-error events, shader and
pixel failures, cancellation, concurrency, release failure/timeouts, partial
reporting/retry, real reload, true gestures, ES5 syntax, all 18 positive cases,
public API isolation, reviewed import and packaging rollback.

If every controlled physical case fails, the supported conclusion is **“no
accessible WebGL context in the tested stock applet.”** Identify compilation,
embedding policy or backend initialization as the cause only when matching
source or physical evidence distinguishes them. Preserve source-supported leads
in the [homebrew research ledger](webgl-source.md#homebrew-research-ledger-and-stopping-rule).

If a context passes rendering checks, reproduce that exact firmware, applet,
origin and attributes across **three fresh sessions**, then compare Diablo's
existing experimental WebGL path against Canvas with matched gameplay and input
latency measurements. Promotion still requires the ten-minute physical gameplay
session. A renderer string, successful menu or animation is insufficient.
