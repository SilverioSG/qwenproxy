# Local workaround for the Node/V8 async stack hang

## Scope

On V8 `14.6.202.34-node.28` (verified with Node 26.8.1), QwenProxy
disables async stack enrichment using `v8.setFlagsFromString` before
application initialization. The guard is imported by the shared configuration
and the main entrypoint. It applies to this Node process, not Chromium or
other applications. The main entrypoint logs when it is active.

Promise execution, error messages, synchronous stack frames and
`Error.captureStackTrace` remain available. Error stacks no longer contain
V8's additional async ancestry. The guard does not change account routing,
CAPTCHA handling, retries or existing renderer recovery.

## Evidence

The verified binary has Build ID
`730b838f7132f4061a52394a2a46480cfc1f9398`. A valid JavaScript promise species
constructor can return an existing promise and create a cyclic reaction graph.
Capturing an Error during the first pending reaction then loops inside
`CaptureAsyncStackTrace`. Some branches follow promises without adding stack
frames, so a finite `Error.stackTraceLimit` does not guarantee termination.

The isolated reproducer hits ELF offset `0x1341b9a`, takes the branch to
`0x1341758`, and revisits promise identities with builder index 1 and limit 100.
The unprotected child times out; the guarded child captures both kinds of
stack and executes all 30 handlers plus its timer.

Original incident samples return to caller A at `0xac8173`, and lie in this
async region. This reproduces a compatible failure mechanism; it does not
prove how the incident's promise graph was formed. The callback used by
`PrintCurrentStackTrace` runs after capture and is not the workaround target.

Source: [Node v26.8.1 isolate.cc](https://github.com/nodejs/node/blob/v26.8.1/deps/v8/src/execution/isolate.cc)
(`CaptureAsyncStackTrace`, `CaptureSimpleStackTrace`, `PrintCurrentStackTrace`).

## Validation

Run `npm run typecheck`, then `npm run test:mock` (includes the child-process
regression). The cyclic regression runs only on the guarded V8 version;
the normal stack/promise test runs on all supported versions. Each child
has a hard timeout and is killed if capture fails to terminate.

To compare manually on the affected runtime, **only in an isolated process**:

```sh
timeout --kill-after=1s 3s node --import tsx --env-file=.env.test src/tests/fixtures/async-stack-cycle.mjs --unprotected
node --import tsx --env-file=.env.test src/tests/fixtures/async-stack-cycle.mjs
```

The first is expected to time out after `CAPTURE_START`. The second must print
`CAPTURE_DONE` and `EVENT_LOOP_ALIVE`. Never inject the unprotected case into
the running server.

## Deployment and removal

Restart QwenProxy after installing the patch. Confirm the runtime guard
startup line, then health/models and real chat, streaming and tools.
Successful smoke tests do not establish long-term absence of the natural
incident.

The version check is deliberately narrow. Before upgrading Node, rerun the
isolated reproducer against the candidate runtime; do not infer that a new
version fixes the bug because the guard no longer matches. Remove or extend
the guard only after that verification. Reverting this patch and restarting
restores async stack enrichment and the exposure on the affected runtime.
