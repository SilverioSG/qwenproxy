# Terminal CDP session context recovery

Patchright Core 1.63.0 retries `Frame._context()` recursively when its CDP
context lookup returns no execution context ID. `_sendMayFail()` turns a
terminal `CRSession.send()` rejection into `undefined`. A renderer can be
crashed while its frame is still attached, so the detach check does not stop
the recursion. Immediately rejected lookups keep the microtask queue busy,
prevent timers and cleanup from running, and retain pending promise chains.

The November 5, 2026 production core showed a crashed page and CDP session,
an attached main frame without a main-world context, and execution inside
this dependency method. Approximately 87.3 million promises and 87.3 million
promise reactions accounted for 7.8 GiB before V8 aborted at its heap limit.
The async-stack workaround addresses a separate failure mechanism and stays
enabled on its verified runtimes.

`bin/patch-patchright.mjs` adds `CRSession.send()`'s existing terminal-session
check to the start of `Frame._context()`, after resolving the client. It
throws the dependency's own `ProtocolError` with its original type/logs.
This prevents `_sendMayFail()` from swallowing a terminal error, including on
a recursive re-entry after a crash during an outstanding lookup. Healthy
navigation retries and context registration are unchanged. It does not fix
the underlying Chromium renderer crash.

The npm `postinstall` lifecycle installs the fixes atomically and is
idempotent. The patch supports exactly the pinned Core 1.63.0 source shape;
an unexpected version or source fails installation for review. The installer
ships in `bin` in the npm package and is copied before Docker's `npm ci`.
After pulling this fix into an existing installation, run
`node bin/patch-patchright.mjs` (or install dependencies normally), then
restart the service when its active requests have drained. An existing Node
process has already loaded the dependency and needs a restart. Installations
using `--ignore-scripts` must run the installer explicitly.

Run typecheck before the canonical mock suite. The regression extracts the
installed dependency's real `_context`, `send`, and `_sendMayFail` methods
into a child process without Chromium, credentials, or production accounts.
Its unpatched control stops after 10,000 iterations and demonstrates timer
starvation. The patched cases cover terminal sessions in main, utility, and
child frames, a crash during a lookup, transient navigation failure, and
independent healthy sessions. The child has a 128 MiB heap cap and an external
hard timeout.

## Upstream review, November 6, 2026

Reviewed Patchright driver and Node packages, `johngbl/qwenproxy` through
`18effdd82c`, and the original `pedrofariasx/qwenproxy` repository. Relevant
closed PRs were checked for actual merge status; a closed PR alone is not a
released fix.

- [Patchright #246](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/246)
  describes the same terminal-session recursion, including the guard used
  locally. [#247](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/pull/247),
  merged as `86be858e9c` on October 1, propagates terminal `send()` errors and
  fixes the per-request network listener leak. Its context fix is present
  in the published 1.64.1 driver. The existing local guard remains scoped to
  1.63.0 and covers the demonstrated recursion.
- The installer now backports the listener-dispatch portion of #247:
  `RouteImpl` no longer registers a `Fetch.requestPaused` listener per request;
  the existing manager forwards tracked responses to their matching route.
  A regression using the installed dependency's methods reproduces 1,000
  retained listeners before the patch and zero additional listeners after it,
  and verifies document response fulfillment and ordinary request pairing.
- [Patchright #253](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/pull/253)
  was closed **without merging**, as a possible duplicate. It is not treated
  as a shipped fix. GitHub's driver Releases endpoint reports 1.64.1, but the
  npm registry publishes **1.64.3** (November 2, 2026). The 1.64.3 tarball was
  downloaded separately, its SHA-512 verified against registry metadata, and
  its code checked for the terminal-error propagation, listener dispatch, and
  [#260](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/pull/260) fix for
  restarted requests behind an authenticated proxy. Its browser manifest uses
  Chromium 156 / revision 1248, versus Chromium 153 / revision 1243 locally.
  The local dependency/browser version is retained for this targeted backport;
  an upgrade needs separate Qwen compatibility validation. No downloaded
  package was installed into production during the upstream review.
- QwenProxy [c58327a](https://github.com/johngbl/qwenproxy/commit/c58327a087fdd07281cd22e551d7ae0c1945999c)
  and [6b14aae](https://github.com/johngbl/qwenproxy/commit/6b14aae914bfb92d5d8c008a88b14753876e49e4)
  identify proactive-header-refresh suppression and unsafe probing during
  active streams. Locally, background refresh now queues on the page mutex,
  owns its in-progress flag inside the refresh, and checks the account lease
  again after acquiring the mutex. Background lock timeout does not reset a
  profile. Tests cover actual refresh progress, mutual exclusion, and a lease
  claimed during the wait.
- The context limit now reserves one slot before initialization and reconciles
  after it, with zero supported as the reserve target for a configured limit
  of one. Cooldown accounts are preferred for eviction. Existing lease,
  temporary-busy, close-gate, and mutex checks remain in force; active work
  can temporarily exceed the soft limit rather than being interrupted.
- The local installer audit also found a symlink entrypoint that silently
  skipped installation and cleanup that deleted a pre-existing temporary
  file after `wx` failed. Real-path entry detection and ownership-aware cleanup
  fix both; regressions cover these failures and installation idempotence.

The upstream mutex epoch fix is already covered by the local generation
counter and its A/B/C stale-owner regression. Upstream CAPTCHA and auth
changes are not imported wholesale: this checkout has separate manual
verification, non-mutating validation, refresh transport, and account context
ownership safeguards. No CAPTCHA, OTP, or account recovery is exercised by
these tests. The original Chromium crash remains outside the demonstrated
Node retention and listener defects.

## Renderer heap exhaustion and session validation, November 6, 2026

The later pool degradation was not another Node restart. Node stayed alive,
while the retained journal contained 436 Chromium renderer cores between
18:42 and 21:07 CET, all with the same first four native stack offsets.
Offline analysis of renderer PID 1214452 identified Blink's V8 OOM handler
(`v8_initializer.cc`) and its crash key `Reached heap limit`. Its command
line imposed `--max-old-space-size=256`. The original core remains intact;
no debugger attached to a live process.

A network-free browser reproduction with the installed Patchright/Chromium
crashes while allocating a retained 320 MiB JavaScript workload under the
256 MiB cap; the identical workload completes with 1024 MiB. The default
`PLAYWRIGHT_JS_HEAP_MB` is therefore 1024. Explicit operator overrides remain
supported, as do the context-count and active-lease protections. This raises
only Chromium's renderer budget, not Node's heap. It does not prove the
absence of every frontend leak or establish the cause of older renderer
crashes for which no equivalent core was examined.

The same incident exposed separate validation defects:

- The init path collapsed an inconclusive settings probe and a false/deferred
  recovery result into `Session expired ... re-authentication failed`. Retry
  policy treated that invented confirmation as `AuthInitFailed`, persisting
  `rejected` after the temporary cooldown expired. Init now preserves the
  three-way result, and its final settings proof decides the outcome.
- Startup's generic error handler also marked every init failure as an auth
  rejection. Renderer/navigation failures now use `InitFailed` instead.
- `probePageLoggedIn` omitted the Bearer required by settings, although the
  ordinary browser transport already supplied it. The probe now uses the
  existing live jar token, falling back to localStorage during hydration.
  It makes no refresh request and never logs the token.
- Missing JSON, service errors and a failed settings fetch previously fell
  through to `ok`. Only HTTP 200 with explicit application success can now
  validate. HTTP/logical auth rejection stays rejected; unavailable or
  malformed replies stay inconclusive. Recovery no longer fabricates HTTP
  200 merely because an inconclusive reason starts with `settings-`.

Regression tests execute the real in-page closure and cover Bearer transport,
network/HTTP/schema errors, final conclusive rejection, deferred recovery,
personalization wrappers and startup cooldown persistence. Against the old
probe, the three transport/error tests fail; they pass with the corrected
probe. Header-only fixtures now provide explicit synthetic auth proof instead
of relying on the old shortcut that accepted a page without `evaluate`.

At diagnosis, 22 of 24 accounts were rejected. Six had no explicit revoked
refresh response in the retained application log; sixteen had a server
`Token is revoked` response. This distinction does not establish that the six
are currently authenticated. Existing account states, sessions and profiles
must not be rewritten to fabricate recovery. Each account still requires the
normal authoritative verification before re-admission. Health/liveness and a
passing mock suite alone do not demonstrate pool recovery or live completion
success for every account.

Validation for this change: typecheck PASS; 55 focused tests PASS; canonical
mock suite 1357 PASS / 0 FAIL / 1 SKIP (1358 total). All ran with test data
isolated from production. The browser heap reproduction used no network or
account material.

## Create-chat classification and upstream review, November 7, 2026

Three accounts verified during the November 6/7 recovery were excluded again
64, 82 and 111 minutes later. Their last request first renewed the access token
successfully, then failed with `CreateChatInvalidResponse` and an empty response
preview. Retry policy treated that generic error code as `AuthInitFailed` and
persisted `rejected`. The response did not establish an authentication failure.

Generic `CreateChatInvalidResponse` and `CreateChatFailed` now retain account
rotation, a fresh chat, full prompt replay and the temporary init cooldown, but
use `InitFailed`. Explicit upstream HTTP 401 or logical Unauthorized still uses
`AuthInitFailed`. Regression tests apply the resulting cooldown to isolated
accounts and verify persisted auth state, including the conclusive auth cases.
This prevents future false exclusions; it does not re-admit existing rejected
accounts or solve the upstream response failure. Those require authoritative
validation, without rewriting auth state by hand.

The November 7 review found no commits since the previous review in either
QwenProxy upstream. `johngbl` at `18effdd82c` still groups generic create-chat
failures with auth errors, using `AuthExpired`; importing that branch would
not correct the distinction required by this fork's persistent auth state.
Original QwenProxy PRs #44, #59 and #61 are closed without
merging; none contains a fix for this retry-policy classification. Its open
PR #72 concerns API compatibility and uploads. QwenGate
[#40](https://github.com/youssefvdel/qwengate/pull/40) remains open: its cookie
persistence, JWT expiry and browser refresh changes have counterparts here.
Its later [#99](https://github.com/youssefvdel/qwengate/issues/99) reports
continuing WAF failures; it does not establish a fix or a provider TTL change.
Patchright #247 is already backported; #260 concerns authenticated proxies,
while #264 is still open and changes document interception. None demonstrates
a remedy for the observed Qwen authentication/WAF failures. Dependencies are
unchanged.

Validation: the new regression fails against the previous policy; typecheck
PASS, 60 focused tests PASS, canonical mock suite 1359 PASS / 0 FAIL / 1 SKIP
(1360 total). Production data and credentials were excluded from the test run.
