# Switch 2 WebGL source and configuration investigation

Research date: **2026-10-12** (Asia/Makassar). Scope: the stock Switch 2 browser.

**Current conclusion:** five earlier Diablo capability reports returned no WebGL
context. The reason is still unresolved. We have not obtained Nintendo's matching
source archive, and upstream WebKit is a reference for discriminating tests, not
evidence of Nintendo's compiled configuration.

## Device and physical evidence

The owner reconfirmed system version **23.0.1** on 2026-10-12. Handheld/docked
state has not been confirmed. The new isolated probe must record both before
classifying a new physical run. Firmware is owner-reported because a browser UA
does not provide the console system version.

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

## Source provenance and retrieval blocker

Nintendo's [official OSS catalog](https://support.nintendo.com/jp/oss/index.html),
as exposed by the search index on the research date, lists **Nintendo Switch 2
23.0.0 or later**, 187 MB compressed and 694 MB expanded. This range includes the
owner's 23.0.1. The separate Nintendo Switch entry is 261 MB and must not be
substituted for the Switch 2 archive.

Live retrieval of the official index returned **HTTP 403** through the web
fetcher, direct HTTPS curl, and one ordinary navigation in installed headless
Google Chrome. The real browser reached the official URL and displayed a
`403 Forbidden` title and body. Nintendo's legacy
`https://www.nintendo.co.jp/support/oss/index.html` redirected to the same blocked
page. Response headers and the small error bodies are retained under the ignored
`data/qa/webgl-source/` directory. This is a retrieval failure, not evidence that
Nintendo offers no source.

| Requested material | Verification state | Archive SHA-256 |
| --- | --- | --- |
| Nintendo Switch 2 OSS, 23.0.0 or later | Catalog entry observed; archive link/bytes not obtained | **Unavailable; no archive downloaded** |
| Upstream WebKit reference | Selected files downloaded at commit `4fc253b3b03c475575f5f4edd1b1406bec0697c7`, committed 2026-10-11 16:29:03 UTC | Per-file hashes below; this is not a Nintendo archive |

The next source acquisition step requires restored access to the official
catalog, then following its Switch 2 23.0.0+ download link and recording the exact
URL, final URL, byte length and SHA-256 before extraction. Do not invent the link,
substitute a proprietary firmware dump, or call an unverified mirror matching.
Inspect the archive's build manifests and port modifications alongside generic
WebCore files; supplied source alone may still omit runtime applet settings.

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

Confidence below concerns the **Switch-specific hypothesis**, not confidence
that the cited upstream mechanisms exist.

| Hypothesis | Source evidence | Physical observation | Next discriminating test | Confidence | Homebrew relevance |
| --- | --- | --- | --- | --- | --- |
| Existing attributes or detached-canvas handling cause failure | Khronos context attributes; current renderer settings | Five small detached-canvas startup reports return null | Fresh visible/detached canvases, omitted/minimal attributes, direct trusted tap | Unresolved | An ordinary compatible setup could remove the need for deeper platform work. |
| WebGL is excluded at compile time | Upstream `ENABLE(WEBGL)` and conditional IDL | Null results do not distinguish exclusion | Matching archive: inspect generated feature defines and build inputs, then reconcile with API exposure | Unresolved | Identifies an implementation boundary only; no method for installing a changed browser is established. |
| The applet disables an embedding preference | Upstream runtime gate and native setter | Null results consistent with several causes | Source trace of Nintendo/NetFront initialization; compare a demonstrably different stock entry point if reachable | Unresolved | Useful configuration lead if future independently established native access exists. No such access is demonstrated here. |
| Graphics backend initialization fails or is unavailable | Upstream graphics-client creation path | Previous reports lack creation-error messages | Capture event text/exceptions on a clean page, then inspect matching port backend | Unresolved | Porting/driver requirement, not proof of an exploitable failure. |
| Origin or applet policy changes availability | Embedding policies may differ; Nintendo policy is not known | Historical tests do not provide a controlled origin comparison | Same revision through captive hostname, direct LAN, valid public HTTPS; two fresh openings | Unresolved | May identify a reachable stock configuration; navigation alone is not an applet switch. |
| Game memory pressure caused initial nulls | Probes ran before game initialization | Existing tests used tiny canvases before engine heap allocation | Minimal isolated page with one retained context; bounded cleanup/reload | Weakened, not eliminated | Resource behavior only; no code-execution implication. |

## Homebrew research ledger and stopping rule

This pass has established a working stock page execution surface and specific
upstream configuration boundaries worth comparing with Nintendo's OSS. It has
not established a vulnerability, native code execution, writable browser
preferences, firmware modification, or a way to launch arbitrary URLs in other
applets. UA version strings alone do not identify a vulnerable revision or prove
the absence of downstream patches. Earlier speculative CVE claims are not
carried into this ledger.

If the controlled matrix fails on every reachable origin, publish **“no
accessible WebGL context in the tested stock applet”** with revision, UA,
owner-reported firmware and physical mode. Leave compilation, embedding policy
and backend failure unresolved until corresponding evidence distinguishes them.
A context that draws correct pixels advances to shader, visible animation,
context recovery and real gameplay tests; it does not yet establish hardware
acceleration or sustained gameplay performance.
