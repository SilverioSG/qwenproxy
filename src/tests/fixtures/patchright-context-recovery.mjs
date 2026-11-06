// Exercise the installed dependency's methods, without Chromium or accounts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { AsyncLocalStorage } from "node:async_hooks";
import { patchContextSource, terminalSessionGuard } from "../../../bin/patch-patchright.mjs";

// Preserve the production workaround while testing this independent failure.
setFlagsFromString("--no-async-stack-traces");
const require = createRequire(import.meta.url);
const packagePath = require.resolve("patchright-core/package.json");
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const source = patchContextSource(
  readFileSync(join(dirname(packagePath), "lib/coreBundle.js"), "utf8"), version,
);

class ProtocolError extends Error {
  constructor(type) { super(`Protocol error: ${type}`); this.type = type; }
}

function extract(bundle, begin, end, name, bindings = {}) {
  const start = bundle.indexOf(begin);
  const stop = bundle.indexOf(end, start);
  if (start === -1 || stop === -1) throw new Error(`Missing dependency method ${name}`);
  const method = bundle.slice(start, stop).trim().replace(
    new RegExp(`^(async )?${name}\\(`),
    (_, asyncPrefix) => `${asyncPrefix || ""}function ${name}(`,
  );
  return Function(...Object.keys(bindings), `return (${method})`)(...Object.values(bindings));
}

function contextMethod(unpatched = false) {
  return extract(unpatched ? source.replace(terminalSessionGuard, "") : source,
    "      async _context(world) {", "\n      context(world) {", "_context", {
      ProtocolError, CRExecutionContext: class {}, FrameExecutionContext: class {},
    });
}
const send = extract(source, "      async send(method, params2) {",
  "\n      _sendMayFail(method, params2) {", "send", { ProtocolError });
const sendMayFail = extract(source, "      _sendMayFail(method, params2) {",
  "\n      _onMessage(object) {", "_sendMayFail", { debugLogger: { log() {} } });

async function run({ terminal, world = "main", unpatched = false, failDuringSend = false, transient = false }) {
  let calls = 0;
  let timerFired = false;
  const method = contextMethod(unpatched);
  const client = {
    _crashed: terminal === "crashed", _closed: terminal === "closed",
    _connection: {
      _closed: terminal === "disconnected",
      _browserDisconnectedLogs: terminal === "disconnect-logs" ? "offline probe" : undefined,
    },
    send, _sendMayFail(...args) {
      calls++;
      if (failDuringSend) this._crashed = true;
      if (this._crashed || this._closed || this._connection._closed || this._connection._browserDisconnectedLogs)
        return sendMayFail.apply(this, args);
      if (transient && calls === 1) return Promise.resolve(undefined);
      return Promise.resolve({ result: { objectId: "object.7.1" }, executionContextId: 7 });
    },
  };
  const session = { _client: client, _onExecutionContextCreated() {} };
  const frame = {
    _isDetached: () => calls >= 10_000, // Bounds the unpatched negative control.
    _context: method,
    _getFrameMainFrameContextId: () => client._sendMayFail("Runtime.evaluate").then(r => r?.executionContextId),
  };
  frame._page = {
    mainFrame: () => world === "child" ? {} : frame,
    delegate: { _sessionForFrame: () => session, _mainFrameSession: session },
  };
  const timer = setTimeout(() => { timerFired = true; }, 0);
  let error = null;
  let result;
  try {
    result = await new AsyncLocalStorage().run("offline probe", () => method.call(frame, world === "child" ? "main" : world));
  } catch (caught) {
    error = caught instanceof ProtocolError ? caught.type : caught.message;
  }
  const timerFiredBeforeSettlement = timerFired;
  await new Promise(resolve => setTimeout(resolve, 0));
  clearTimeout(timer);
  return { calls, error, contextReturned: !!result, timerFiredBeforeSettlement, timerFired };
}

if (process.argv.includes("--unpatched")) {
  console.log(JSON.stringify(await run({ terminal: "crashed", unpatched: true })));
} else {
  const results = {};
  for (const terminal of ["crashed", "closed", "disconnected", "disconnect-logs"]) {
    for (const world of ["main", "utility", "child"]) {
      results[`${terminal}:${world}`] = await run({ terminal, world });
    }
  }
  results.duringSend = await run({ failDuringSend: true });
  results.transient = await run({ transient: true });
  // A terminal failure above must leave an independent healthy session usable.
  results.healthyMain = await run({});
  results.healthyUtility = await run({ world: "utility" });
  results.healthyChild = await run({ world: "child" });
  console.log(JSON.stringify(results));
}
