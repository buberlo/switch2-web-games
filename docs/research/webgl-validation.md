# WebGL research validation — 2026-10-12

This record separates local harness validation from physical Switch 2 evidence.
The owner reconfirmed firmware **23.0.1**. The first physical comparison records
handheld mode and the Wi-Fi login applet UA. No renderer default or gameplay
acceptance gate changed.

## Local results

| Check | Result | Scope |
| --- | --- | --- |
| Python suite | 55 tests passed | Existing captive GET/HEAD, selective DNS, saves, service recovery, identity plus six new bundle tests |
| WebGL core | 22 scenarios passed | WebGL 1, alias and WebGL 2 render/readback; deliberate disable, exceptions, creation-error events, shader/pixel faults, cancellation, deadlines, resource cleanup and actual onscreen creation |
| ES5 parsing | Passed with Acorn 8.15.0 | Core, controller and shared transport |
| Controller | Passed | All 18 real positive cases; actual trusted clicks; no active transient input in automatic cases; partial authenticated reports and retry; cancellation; reload; public API isolation; bounded reviewed imports |
| Full positive report | 56,475 bytes in the final local test | Below the 60 KiB report bound and 64 KiB endpoint limit; manual JSON return exercised above the 32 KiB URL bound |
| Packaging | Six tests passed | Exact upload allowlist, source identity, no private config in upload, stale/extra file rejection, symlink rejection and rollback on local-config failure |
| Live captive response | HEAD returned 302 to `/portal` | Existing service remained in place |
| Diablo identity | Unchanged and verified | Engine/frontend combined revision `e3189ccb6f2431c5db5f8bcaa8297e4762d7f494c6ede0a8bee4f6cf5061c3b8` |

Positive rendering used local Chrome with software WebGL available. The disabled
control used Chrome with `--disable-webgl --js-flags=--jitless`. These results
validate the harness and do not establish Switch rendering capability. Browser
tests allocate at most one live successful context and delete every test-created
GL resource. The intentionally missing release path stops and requires reload.
Visibility regressions place the container 2,000 pixels below the viewport at
1280×720 and 390×400, then verify that context creation is both onscreen and still
inside the trusted event stack. Detached creation remains detached and its later
animation is revealed. The next gesture control scrolls back into view.

Local evidence lives under ignored `data/qa/webgl-research/`; raw device logs and
session data are not published. The first Python attempt was blocked by sandbox
socket permissions; the authorized rerun with temporary socket access passed all
55 tests. Neither attempt modified the console-facing services.

## Public deployment

The ten-file static bundle is deployed using direct upload:

- [Public probe](https://switch2-webgl-probe.pages.dev/assets/webgl-research.html)
- [Immutable deployment](https://9b2b8064.switch2-webgl-probe.pages.dev/assets/webgl-research.html)
- Probe source revision: `14c857cd751d10d333e241ae742210702e8e5d7ae0467fcf68f89ddb64f4fc5b`

The actual public HTTPS deployment passed byte-for-byte source/manifest checks,
`no-store` header checks, missing game/API/log-route 404 checks and all 18 cases
in a deliberately WebGL-disabled desktop browser. The browser made no API or LAN
requests, reported a secure context and produced a bounded explicit return link.
Browser checks rejected leading-zero IPv4 return addresses whose URL parsing
could otherwise turn a claimed private address into a public destination.
Certificate validation remained enabled. Pages' HTML canonical redirects were
followed successfully. The local portal serves the same probe source revision.

No game data, saves, engine build or local logs are part of the public bundle.
GitHub Actions remain disabled. A first project-create attempt was delegated by
Wrangler to Workers and failed without deployment; explicit direct Pages creation
then succeeded. Subsequent upload used the existing Pages project normally.
These deployment controls are covered by the documented CLI commands and
`scripts/check_webgl_deployment.cjs`.

## Physical origin comparison

| Origin | First fresh applet opening | Second fresh applet opening |
| --- | --- | --- |
| Captive connection-check hostname | 18/18 null; all six trusted taps completed | 18/18 null after Wi-Fi reconnect; report received |
| Direct LAN address | 18/18 null; all six trusted taps completed | Owner says repeated null; origin-specific saved report pending |
| Public HTTPS control | Original URL returned to portal; direct canonical page opens and owner reports all null; separate first saved report absent | Returned report labels opening 2: 18/18 null in a secure context |

The console reports arrived at **01:17:53 and 01:19:27 on 2026-10-12**,
Asia/Makassar (17:17:53 and 17:19:27 UTC on 2026-10-11), and match the published
probe revision above. Both completed runs report firmware 23.0.1, handheld mode,
opening number 1 and this exact UA:

```text
Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/613.0 (KHTML, like Gecko) NF/7.0.3.12.11 NintendoBrowser/5.2.0.55481
```

All 36 first-comparison context requests returned null, with **zero exceptions and zero
creation-error messages**. Neither WebGL constructor was exposed. Every attached
creation canvas was fully onscreen; all detached cases were actually detached.
Six requests per origin came directly from trusted clicks. The transient
activation API was unavailable, so the automatic checks used the recorded
six-second fallback delay. The page was visible and top-level. Its reported
1920×1080 CSS viewport is retained as browser geometry; it is not used to infer
physical mode.

Opening number and handheld mode are owner-selected metadata; applet closure was
not independently observed. The owner confirms that Connection Test alone did
not reopen the portal, while reconnecting Wi-Fi did. The second captive report
arrived at **01:24:28 on 2026-10-12**, Asia/Makassar, with the same revision,
firmware, UA and handheld selection: 18/18 null, six trusted clicks, no exceptions
or creation-error text, and correct canvas placement. This brings the recorded
completed total to **54 null context requests**. The owner's repeated-null answer
is retained separately from the still-missing second origin-specific LAN report.
An earlier incomplete captive run retained 13 null cases and is documented
without being counted as a completed comparison.

The owner clarified that HTTPS navigation **returns to the local portal**.
The selective DNS log shows the console queried the public hostname and received
public A records through normal upstream forwarding. Mac HTTPS checks verified
the certificate and found that `/assets/webgl-research.html` returns **308** to
`/assets/webgl-research`, whose response is **200**. The library's **Direct HTTPS
probe** link now uses that canonical path and carries the same explicit LAN
return fragment. Desktop browser navigation verified a single document-200
response, correct return address and the unchanged probe revision. The owner
confirms that this direct page opens on the console and all checks return null.
Whether the redirect caused the original return is still unresolved.

The explicitly reviewed HTTPS report arrived at **01:34:57 on 2026-10-12**,
Asia/Makassar. It records the public HTTPS origin, `secureContext:true`, the same
revision and applet UA, firmware 23.0.1, handheld mode and selected opening 2.
All 18 cases return null, with six trusted taps, correct canvas placement,
missing WebGL constructors and no exceptions or creation-error messages. This
brings the saved complete total to **72 null requests across four reports**.
The owner confirms the requested save/repetition procedure was completed. Only
one HTTPS report was received; a separate first HTTPS report and second LAN
report are absent. Do not infer extra saved runs from repeated snapshot posts.
Public results are URL-fragment imports submitted from the LAN, explicitly
marked **untrusted**, and corroborated by the owner's observations; matching
transport UA does not independently authenticate the public report's contents.

The [sanitized measurements](../measurements/2026-10-12-switch-webgl.json) retain
case names, requested attributes, trusted events, API exposure, geometry and
outcomes. Private LAN addresses, transport addresses, random run identifiers and
session data are omitted. The supported physical conclusion is **“no accessible
WebGL context in the tested stock applet”** across captive HTTP, direct LAN HTTP
and reachable public HTTPS. Origin, minimal attributes, canvas attachment and
trusted input did not expose a usable context in these cases.

Do not fill a pending cell from desktop results or an unreachable origin. For
each physical result retain the exact probe revision, observed UA, firmware,
mode, all 18 case outcomes and error messages. If a case succeeds, the separate
three-session reproduction, Diablo comparison and ten-minute gameplay gates
remain required.

## Source acquisition

Initial catalog retrieval received HTTP 403. A later official catalog fetch
exposed the **Switch 2 23.0.0 or later** archive link; direct TLS-verified download
returned HTTP 200 and **197,123,071 bytes**. ZIP CRC verification passed all
40,478 entries. Archive SHA-256:
`a2bcdfb7ec695d1ac5c790317a1239ccdb40e0ba8e052891c2ebba1314200f90`.

The WKC version header identifies customer release **3.12.11** and WebKit
**613.0**, matching the applet version strings. The corresponding WKC feature
header sets both WebGL flags to **0**. Local Clang preprocessing of that header
confirmed both values; this is a source-header check, not an applet build.
The source therefore supports compilation exclusion as the leading explanation,
while the shipped binary and final build inputs remain unverified. The browser
initialization also defaults accelerated compositing off and contains native
settings/backend gates that page JavaScript cannot override.

The reproducible [source manifest](nintendo-webgl-source-manifest.json) and
[source investigation](webgl-source.md) retain exact paths, hashes, line references,
limitations and homebrew leads. The archive remains outside Git. The audit
reproduced the manifest and rejected an incorrect-length archive. Neither source
inspection nor physical null results enable hardware acceleration.
