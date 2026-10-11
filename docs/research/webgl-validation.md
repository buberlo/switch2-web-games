# WebGL research validation — 2026-10-12

This record separates local harness validation from physical Switch 2 evidence.
The owner reconfirmed firmware **23.0.1**; the new matrix must also record physical
mode and applet UA. No renderer default or gameplay acceptance gate changed.

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
| Captive connection-check hostname | Pending | Pending |
| Direct LAN address | Pending | Pending |
| Public HTTPS control | Pending | Pending |

Do not fill a pending cell from desktop results or an unreachable origin. For
each physical result retain the exact probe revision, observed UA, firmware,
mode, all 18 case outcomes and error messages. If a case succeeds, the separate
three-session reproduction, Diablo comparison and ten-minute gameplay gates
remain required.

## Source acquisition

Nintendo's indexed OSS catalog identifies a Switch 2 **23.0.0 or later** archive,
matching the owner-reported firmware range. Direct HTTPS retrieval, the web
fetcher and installed Chrome all received HTTP 403. No archive was obtained and
no archive hash or Nintendo build flag is claimed. The pinned upstream analysis
and homebrew-relevant hypotheses remain clearly labeled in
[the source report](webgl-source.md).
