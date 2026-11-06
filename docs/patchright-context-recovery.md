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
