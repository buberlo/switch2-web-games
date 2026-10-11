# Switch 2 WebGL source and configuration investigation

Research date: **2026-10-12** (Asia/Makassar). Scope: the stock Switch 2 browser.

**Current conclusion:** there is **no accessible WebGL context in the tested
stock applet** across captive HTTP, direct LAN HTTP and reachable public HTTPS.
Four saved complete reports contain 72 null requests, including trusted taps.
Nintendo's official Switch 2 23.0.0+ archive was obtained: its WKC 3.12.11 source
sets both WebGL feature flags to **0**, and its version header matches WebKit
613.0/customer 3.12.11 in the applet UA. This establishes a compile-time gate in
the distributed configuration and makes compilation exclusion the leading
explanation. It does not independently establish the shipped binary's final
build inputs. The approximate upstream references below remain separate.

## Device and physical evidence

The owner reconfirmed system version **23.0.1** on 2026-10-12 and selected
**handheld** mode in both completed standalone reports. Firmware and physical
mode are owner-reported because browser UA and CSS viewport do not establish
them. Both new reports reproduce the exact Wi-Fi login applet UA below.

The following is the exact applet UA from the existing console reports; capture
it again on each new run rather than inferring it from the firmware:

```text
Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/613.0 (KHTML, like Gecko) NF/7.0.3.12.11 NintendoBrowser/5.2.0.55481
```

Reinspection of the local diagnostic log found these five `capabilities` events.
Repeated benchmark messages containing the same capability object are excluded.
These are five startup reports, **not five proven fresh applet openings**.

| Received, UTC on 2026-10-11 | Engine prefix | WebGL 1 / WebGL 2 | Canvas pixel readback |
| --- | --- | --- | --- |
| 08:21:58 | `b43159d67a7a` | no context / no context | passed |
| 08:23:03 | `b43159d67a7a` | no context / no context | passed |
| 08:24:11 | `b43159d67a7a` | no context / no context | passed |
| 08:39:25 | `ef1a9cd3ac35` | no context / no context | passed |
| 08:41:01 | `ef1a9cd3ac35` | no context / no context | passed |

The renderer requested a detached 4×2 canvas with `alpha:true`,
`premultipliedAlpha:false`, `antialias:false`, `depth:false`, `stencil:false`, and
`preserveDrawingBuffer:true`; WebGL 1 also tried `experimental-webgl`. It reported
`unavailable` on a null return and a different `failed` result for an exception.
It did not record `webglcontextcreationerror`, and the fallback alias reused the
same canvas. These results therefore do not cover the new fresh-canvas matrix.
The probes happened before Diablo's engine initialization. Earlier general
diagnostic probes had weaker null/exception reporting and are not included here.
The raw log remains local; this table omits network addresses and session data.

The standalone probe revision
`14c857cd751d10d333e241ae742210702e8e5d7ae0467fcf68f89ddb64f4fc5b`
subsequently completed the full matrix on the captive hostname and direct LAN
origin. Each yielded 18 null returns, no exceptions and no creation-error text.
All attached canvases were fully onscreen and all six direct trusted taps per
origin were recorded. Neither WebGL constructor was exposed. These measurements
exclude Diablo and its heap. Both are labeled opening 1 by the owner; they do
not establish two independent fresh applet openings. The original HTTPS URL was
marked unreachable, then clarified as a return to the portal. A second captive
report after Wi-Fi reconnect adds
18/18 null with the same revision and correctly recorded trusted taps and canvas
placement. Those three complete reports total 54 null requests. The DNS log shows
the public hostname was forwarded and resolved normally. A direct canonical
HTTPS link opens on the console, but the initial redirect's role is unproven.
The returned public report labels opening 2, records a secure context and the
same firmware/UA/revision, and adds 18 null cases with correct trusted taps and
canvas placement. The owner corroborates the null result and confirms the
requested save/repeat procedure done. Imported results remain marked untrusted;
only one HTTPS report was received. A separate first HTTPS report and second
LAN report are absent, so the saved record does not establish two complete
comparisons of every origin. An incomplete earlier
captive run retains 13 cases without being counted as complete.
See [physical validation](webgl-validation.md#physical-origin-comparison) and
[sanitized case measurements](../measurements/2026-10-12-switch-webgl.json).

## Official source acquisition and provenance

Nintendo's [official OSS catalog](https://support.nintendo.com/jp/oss/index.html),
as exposed by the search index and subsequently the readable catalog, lists
**Nintendo Switch 2 23.0.0 or later**, 187 MB compressed and 694 MB expanded. This range includes the
owner's 23.0.1. The separate Nintendo Switch entry is 261 MB and must not be
substituted for the Switch 2 archive.

Initial retrieval of the official index returned **HTTP 403** through the web
fetcher, direct HTTPS curl, and one ordinary navigation in installed headless
Google Chrome. The real browser reached the official URL and displayed a
`403 Forbidden` title and body. Nintendo's legacy
`https://www.nintendo.co.jp/support/oss/index.html` redirected to the same blocked
page. Those headers and error bodies remain under ignored `data/qa/webgl-source/`.
Later in the same investigation, the web fetcher obtained the catalog with its
actual download links. The Switch 2 23.0.0+ link is
[NS2_23.0.0.zip](https://support.nintendo.com/jp/oss/data/NS2_23.0.0.zip).
Direct download returned HTTP 200 with certificate verification enabled.

| Requested material | Verification state | Archive SHA-256 |
| --- | --- | --- |
| Nintendo Switch 2 OSS, 23.0.0 or later | Official catalog link; 197,123,071 bytes; ZIP CRC passed | `a2bcdfb7ec695d1ac5c790317a1239ccdb40e0ba8e052891c2ebba1314200f90` |
| Upstream WebKit reference | Selected files downloaded at commit `4fc253b3b03c475575f5f4edd1b1406bec0697c7`, committed 2026-10-11 16:29:03 UTC | Per-file hashes below; this is not a Nintendo archive |

The downloaded URL and final URL are the same. All **40,478 ZIP entries** passed
CRC; the expanded total is **728,410,973 bytes**. Extraction checked member paths
and rejected absolute paths, traversal and symlinks. The archive contains two
browser source families, `0.12.2` and `3.12.11`; the latter's `WKCVersion.h:33,35`
matches the applet's customer release and WebKit version strings. This is the
official matching firmware-range distribution, not proof of byte-identical
installed binaries or complete proprietary applet/peer implementation.

Reproduce the source audit without executing or extracting the downloaded code:

```sh
mkdir -p data/qa/webgl-source
curl --fail --location --proto '=https' \
  -o data/qa/webgl-source/NS2_23.0.0.zip \
  https://support.nintendo.com/jp/oss/data/NS2_23.0.0.zip
python3 scripts/audit_nintendo_webgl.py data/qa/webgl-source/NS2_23.0.0.zip \
  > data/qa/webgl-source/audit.json
diff -u docs/research/nintendo-webgl-source-manifest.json data/qa/webgl-source/audit.json
```

The audit rejects mismatched length/hash and verifies every ZIP CRC. Its
[committed manifest](nintendo-webgl-source-manifest.json) records hashes and exact
archive-relative line references for 13 inspected files. The source archive and
extracted tree stay outside Git; vendor notices remain in the local archive.

## Trace through Nintendo's supplied WKC configuration

Paths below are relative to `NS2_23.0.0/` and pinned by that manifest.

1. **Compile-time configuration.** `WKC_3.12.11/include/wkc/wkcconfig.h:23`
   selects WKC. `webkit_3.12.11/WTF/wtf/PlatformEnable.h:103–104` includes
   `FeatureDefinesWKC.h` for that platform. The supplied
   `WKC_3.12.11/WTF/wtf/WKC/FeatureDefinesWKC.h:160–161` defines
   `ENABLE_WEBGL 0` and `ENABLE_WEBGL2 0` without per-flag `ifndef` guards.
   Local Clang preprocessing of this header confirms both zeros. This is not a
   complete Nintendo build; undistributed final build inputs remain unverified.
2. **Dispatch and API exposure.** In
   `webkit_3.12.11/WebCore/html/HTMLCanvasElement.cpp:324–347`, WebGL dispatch is
   compiled only with `ENABLE(WEBGL)`; otherwise the request falls through to
   null. `WebCore/html/canvas/WebGLRenderingContext.idl:38` is also conditional
   on WEBGL. Unlike the newer upstream reference below, this supplied IDL has no
   `EnabledBySetting` annotation. The observed missing constructors and silent
   null requests are consistent with the supplied compile-time exclusion.
3. **Runtime settings would still matter in an enabled build.**
   `HTMLCanvasElement.cpp:408–425` requires accelerated compositing for platforms
   other than GTK/WinCairo and checks `webGLEnabled`. WKC initialization in
   `WKC_3.12.11/WebKit/WKC/webkit/WKCWebView.cpp:637–644` defaults accelerated
   drawing/compositing off while setting the WebGL runtime preference **true**.
   That true value cannot restore compiled-out dispatch. It also means a claim
   that this initialization simply sets `webGLEnabled:false` would be wrong.
   The native helper `helpers/privates/WKCSettings.cpp:703–705` forwards settings;
   no page JavaScript setter is established. Actual applet overrides are unknown.
4. **Policy and backend initialization.** If enabled, supplied
   `WebGLRenderingContextBase.cpp:819,878` checks the frame client's policy and
   requests `hostWindow->createGraphicsContextGL`. WKC's frame loader forwards
   `allowWebGL` to its embedding client under `ENABLE(WEBGL)`
   (`WebCoreSupport/FrameLoaderClientWKC.cpp:1316–1320`). WKC initialization's
   `wkcGLInitializePeer` call is likewise conditional (`WKCWebView.cpp:3646–3647`).
   Native `WKCPrefs.cpp:576–579` calls `wkcGLActivatePeer` only when compiled in.
   It is a native function, not a callable browser-page API.
5. **Porting lead, not a proven backend.** The archive includes
   `include/wkc/wkcglpeer.h` declarations for GL initialization/activation/context
   creation and an older `GraphicsContext3DWKC.cpp` bridge calling those peers.
   Their presence does not demonstrate an enabled or complete modern
   `GraphicsContextGL` implementation. No concrete peer implementation or final
   proprietary applet build was obtained. Changing one header is not established
   as sufficient to build, install or enable graphics on a stock console.

The same feature header also disables WebAssembly at line 156, consistent with
the prior capability reports. Source settings for accelerated Canvas are leads
for native port research; they are not a measured hardware-acceleration result.
Page attributes, gesture timing, URLs and HTTPS cannot alter a compile-time gate.
The supplied legacy `webkit-3d` alias sits inside that same gate and supplies no
independent route around it, so the measured matrix is unchanged.

The cached reference files have this identity. The complete paths, URLs, byte
counts and hashes are in ignored `data/qa/webgl-source/upstream-sources.json`.

| Upstream file | SHA-256 |
| --- | --- |
| `HTMLCanvasElement.cpp` | `43c07c0555b3323c770021937e41631376747d425f14d288fa1c93a39f4eea05` |
| `WebGLRenderingContextBase.cpp` | `59b6b513f563156def5503783a872310834810ed7a5e5c6c66b59e1376896add` |
| `UnifiedWebPreferences.yaml` | `671b0045e59de504deee6c9590e45df03e8e60dcd0f4543a700c6d1daab031ea` |
| `WKPreferences.cpp` | `687f1a283c6dbc53bd66bcdbc029ebc3fae3562dfbd4ce8ead801b7352cf4d19` |
| `WebGLRenderingContext.idl` | `57211160509d297adf8432cfee1e6667b27f7ca25ccdfd71f071efaa3ba4fbf1` |

## What the upstream code establishes

This contemporary upstream revision is **not matched to WebKit/613.0 or
NetFront 7.0.3.12.11**. Its stages define questions to ask of Nintendo's source:

1. **Compilation and context selection.** WebGL dispatch is inside
   `ENABLE(WEBGL)`. The reference accepts `webgl`, `experimental-webgl`, `webgl2`
   and a legacy `webkit-3d` alias. All enter the same creation path; the alias is
   not an independent graphics backend. No Nintendo-specific evidence currently
   justifies adding it to the bounded probe matrix.
   [Pinned HTMLCanvasElement.cpp, lines 379–543](https://github.com/WebKit/WebKit/blob/4fc253b3b03c475575f5f4edd1b1406bec0697c7/Source/WebCore/html/HTMLCanvasElement.cpp#L379)
2. **Runtime embedding preference.** `createContextWebGL` returns null when
   `document().settings().webGLEnabled()` is false, before backend creation.
   `WKPreferencesSetWebGLEnabled` is a native embedding API, not a page JavaScript
   method. A query parameter, canvas attribute or server header does not call
   that native setter.
   [Pinned native preferences API](https://github.com/WebKit/WebKit/blob/4fc253b3b03c475575f5f4edd1b1406bec0697c7/Source/WebKit/UIProcess/API/C/WKPreferences.cpp#L418)
3. **Preference defaults and API exposure.** Upstream's preference definition
   has different defaults for WebCore and the containing browser; those defaults
   are not Nintendo's applet value. The WebGL interface is guarded by both
   `Conditional=WEBGL` and `EnabledBySetting=WebGLEnabled`. A missing constructor
   therefore cannot distinguish compile-time exclusion from a disabled setting.
   [Pinned preferences](https://github.com/WebKit/WebKit/blob/4fc253b3b03c475575f5f4edd1b1406bec0697c7/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml#L7226),
   [pinned interface](https://github.com/WebKit/WebKit/blob/4fc253b3b03c475575f5f4edd1b1406bec0697c7/Source/WebCore/html/canvas/WebGLRenderingContext.idl)
4. **Graphics backend and initialization.** The next stage calls
   `graphicsClient->createGraphicsContextGL`. A missing/failed backend emits a
   generic creation-error event for an HTML canvas and returns null; a later
   initialization failure can instead yield a lost context. In this reference,
   the earlier disabled-setting return emits no such event. Event text can
   narrow the investigation, but an absent or empty event on Nintendo's port
   does not prove a particular cause.
   [Pinned backend creation path, lines 433–550](https://github.com/WebKit/WebKit/blob/4fc253b3b03c475575f5f4edd1b1406bec0697c7/Source/WebCore/html/canvas/WebGLRenderingContextBase.cpp#L433)

Page code controls requested context name, attributes, canvas size/attachment,
timing and ordinary navigation. Those requests do not override embedding policy
or supply a backend omitted from a build. `failIfMajorPerformanceCaveat:false`
permits a slower implementation; `powerPreference` is a preference rather than
an enable switch. A successful context may be software rendered. The standard
permits an empty creation-error message, so null/exception/event/readback must be
recorded separately. [Khronos WebGL context parameters and events](https://registry.khronos.org/webgl/specs/latest/1.0/)

## Stock entry points

ACCESS confirms that Switch 2 uses its WebKit-based NetFront Browser NX for
Nintendo Account linking, Nintendo eShop, rights notices and user manuals. This
establishes uses of the browser component, not arbitrary-URL access or different
WebGL settings in those applets.
[ACCESS's Switch 2 announcement, 2025-06-05](https://www.access-company.com/en/news_event/archives/2025/access-netfront-browser-nx-selected-by-nintendo-for-its-latest-nintendo-switch-2-game-system/)

| Entry point | Evidence that our page can be loaded | Research action |
| --- | --- | --- |
| Connection Test / Wi-Fi login | Existing physical portal and Diablo reports | Run the isolated matrix on the exact current UA. |
| Account linking / eShop | Browser-component use confirmed; our URL not reached | Do not call it a tested alternative until an ordinary reproducible navigation route is documented. |
| Rights notices / manuals | Browser-component use confirmed; our URL not reached | Same requirement; do not infer GPU access from the component name. |

Top-level navigation from the captive page to LAN or HTTPS changes origin; it
does not by itself establish an applet transition. Record the UA and entry route
again if an alternative becomes reproducible. ACCESS's separate DTV product
advertises WebGL, but that is a different profile and does not establish support
in Nintendo's selected configuration.
[ACCESS DTV profile](https://www.access-company.com/en/products/browser/netfront-browser-nx-dtv-profile./)

## Findings and next discriminating tests

Confidence distinguishes the **supplied source configuration** from inference
about the shipped Switch binary. Generic upstream features are not Nintendo
configuration evidence.

| Hypothesis | Source evidence | Physical observation | Next discriminating test | Confidence | Homebrew relevance |
| --- | --- | --- | --- | --- | --- |
| Existing attributes or detached-canvas handling cause failure | Khronos attributes; supplied gated dispatch | All three reachable origins return null for omitted/minimal attributes, onscreen/detached canvases and trusted taps | Preserve remaining repeat reports if obtained; no further arbitrary attribute variants justified | Weakened by controlled physical cases | No ordinary compatible configuration discovered. |
| WebGL is excluded at compile time | Official WKC header disables both flags; platform include and conditional dispatch/IDL traced | Constructors absent and all 72 saved complete requests null | Final shipped build inputs or independent binary evidence; do not modify firmware | High for supplied source; leading inference for tested binary | A replacement implementation would require compiled feature support and a backend; no installation route established. |
| The applet disables an embedding preference | Supplied runtime gates and native helpers; initialization sets WebGL true but accelerated compositing false | Silent nulls remain compatible with runtime gates | Determine actual applet overrides if independently obtainable | Applet-specific policy unresolved; false WebGL default is unsupported | Native settings alone cannot restore excluded code. |
| Graphics backend initialization fails or is unavailable | Supplied host-window context call and conditional GL peers | No exception or creation-error text; disabled dispatch could prevent reaching backend entirely | Establish enabled build before assessing modern backend completeness | Backend viability unverified | GL peer declarations and old bridge identify porting work, not demonstrated acceleration or code execution. |
| Origin or applet policy changes availability | Supplied native policy delegation; other applets' configuration unknown | Captive HTTP, LAN HTTP and reachable secure HTTPS all null | Different stock entry point only with a documented route to this probe | No benefit from tested origin change; other applets untested | Navigation within Wi-Fi applet is not a native applet change. |
| Game memory pressure caused initial nulls | Pre-engine probes and standalone page | Isolated page also returns null across all three origins | No further heap stress needed to explain current evidence | Weakened | No code-execution implication. |

## Homebrew research ledger and stopping rule

This pass has established a working stock page execution surface and specific
matching-source compile, settings and backend boundaries. It has
not established a vulnerability, native code execution, writable browser
preferences, firmware modification, or a way to launch arbitrary URLs in other
applets. UA version strings alone do not identify a vulnerable revision or prove
the absence of downstream patches. Earlier speculative CVE claims are not
carried into this ledger.

If the controlled matrix fails on every reachable origin, publish **“no
accessible WebGL context in the tested stock applet”** with revision, UA,
owner-reported firmware and physical mode. The matching supplied source now
supports compilation exclusion; retain the final-build limitation and leave
actual applet overrides and backend viability unresolved.
A context that draws correct pixels advances to shader, visible animation,
context recovery and real gameplay tests; it does not yet establish hardware
acceleration or sustained gameplay performance.
