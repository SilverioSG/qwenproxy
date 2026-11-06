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

The npm `postinstall` lifecycle installs the guard atomically and is
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
