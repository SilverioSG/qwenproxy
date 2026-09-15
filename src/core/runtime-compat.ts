import { setFlagsFromString } from "node:v8";

// Node 26.8.1 / V8 14.6.202.34-node.28 can loop inside
// CaptureAsyncStackTrace on a cyclic pending promise chain, even with a
// finite Error.stackTraceLimit. Disable only async stack enrichment on the
// verified runtime; synchronous error stacks and promise execution remain.
// Keep this before application initialization. See docs/node-async-stack.md.
export const asyncStackGuardEnabled = process.versions.v8 === "14.6.202.34-node.28";

if (asyncStackGuardEnabled) {
  setFlagsFromString("--no-async-stack-traces");
}
