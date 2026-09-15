// Run only as a child with an external timeout: the unprotected runtime hangs.
if (!process.argv.includes("--unprotected")) {
  await import("../../core/config.ts");
}

Error.stackTraceLimit = 100;
let executed = 0;
const first = Promise.resolve().then(function capturePendingChain() {
  console.log("CAPTURE_START");
  const error = new Error("pending promise chain");
  if (!error.stack.includes("capturePendingChain")) {
    throw new Error("Synchronous stack frame lost");
  }
  const target = {};
  Error.captureStackTrace(target);
  if (!target.stack.includes("capturePendingChain")) {
    throw new Error("Error.captureStackTrace frame lost");
  }
  console.log("CAPTURE_DONE");
});
let tail = first;
for (let i = 0; i < 30; i++) {
  tail = tail.then(() => { executed++; });
}

// A species constructor may return an existing promise. This creates a cycle
// in the reaction graph without native code or modifying V8 heap memory.
if (!process.argv.includes("--acyclic")) {
  tail.constructor = {
    [Symbol.species]: function (executor) {
      executor(() => {}, () => {});
      return first;
    },
  };
  tail.then(() => {});
}

setTimeout(() => {
  if (executed !== 30) throw new Error(`Only ${executed} handlers executed`);
  console.log("EVENT_LOOP_ALIVE");
}, 20);
