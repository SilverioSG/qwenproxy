import { setFlagsFromString } from "node:v8";

// Node 26.8.1 / V8 14.6.202.34-node.28 and Node 26.10.0 / V8
// 14.6.202.34-node.34 can loop inside CaptureAsyncStackTrace on a cyclic
// pending promise chain, even with a finite Error.stackTraceLimit. Disable
// only async stack enrichment on the verified runtimes; synchronous error
// stacks and promise execution remain.
// Keep this before application initialization. See docs/node-async-stack.md.
// Explicit allowlist only: never generalize to wider V8 patterns.
export const affectedAsyncStackV8Versions: ReadonlySet<string> = new Set([
  "14.6.202.34-node.28",
  "14.6.202.34-node.34",
]);

export const asyncStackGuardEnabled = affectedAsyncStackV8Versions.has(
  process.versions.v8,
);

if (asyncStackGuardEnabled) {
  setFlagsFromString("--no-async-stack-traces");
}
