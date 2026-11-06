import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const patchUrl = new URL("../../bin/patch-patchright.mjs", import.meta.url);
const { patchContextSource, patchDependencySource, networkPatchSegments, installContextPatch, terminalSessionGuard } = await import(patchUrl.href) as {
  patchContextSource(source: string, version: string): string;
  patchDependencySource(source: string, version: string): string;
  networkPatchSegments: Array<{from: string; to: string}>;
  installContextPatch(packagePath?: string): boolean;
  terminalSessionGuard: string;
};
const require = createRequire(import.meta.url);
const packagePath = require.resolve("patchright-core/package.json");
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const installed = readFileSync(join(dirname(packagePath), "lib/coreBundle.js"), "utf8");
let pristine = installed.replace(terminalSessionGuard, "");
for (const { from, to } of networkPatchSegments) pristine = pristine.replace(to, from);

test("pinned Patchright patch is idempotent and refuses an unknown source or version", () => {
  const patched = patchContextSource(pristine, version);
  assert.notEqual(patched, pristine);
  assert.equal(patchContextSource(patched, version), patched);
  assert.throws(() => patchContextSource(pristine, "1.64.0"), /Review the context recovery patch/);
  assert.throws(() => patchContextSource("unexpected bundle", version), /found 0/);
  assert.throws(() => patchContextSource(pristine + pristine, version), /found 2/);
});

test("installer persists the guard atomically without changing unrelated dependency files", () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-patchright-install-"));
  try {
    mkdirSync(join(root, "lib"));
    const pkg = join(root, "package.json");
    const bundle = join(root, "lib/coreBundle.js");
    writeFileSync(pkg, JSON.stringify({ version }));
    writeFileSync(bundle, pristine);
    assert.equal(installContextPatch(pkg), true);
    assert.equal(readFileSync(bundle, "utf8"), patchDependencySource(pristine, version));
    assert.equal(installContextPatch(pkg), false);
    writeFileSync(pkg, JSON.stringify({ version: "unsupported" }));
    const before = readFileSync(bundle, "utf8");
    assert.throws(() => installContextPatch(pkg), /Review the context recovery patch/);
    assert.equal(readFileSync(bundle, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer preserves an existing temporary file when exclusive creation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-patchright-collision-"));
  try {
    mkdirSync(join(root, "lib"));
    const pkg = join(root, "package.json"), bundle = join(root, "lib/coreBundle.js");
    const temporary = `${bundle}.qwenproxy-${process.pid}.tmp`;
    writeFileSync(pkg, JSON.stringify({ version }));
    writeFileSync(bundle, pristine);
    writeFileSync(temporary, "existing file");
    assert.throws(() => installContextPatch(pkg), { code: "EEXIST" });
    assert.equal(readFileSync(temporary, "utf8"), "existing file");
    assert.equal(readFileSync(bundle, "utf8"), pristine);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("npm install entrypoint also runs through a symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "qwen-patchright-link-"));
  try {
    const dependency = join(root, "node_modules/patchright-core");
    mkdirSync(join(dependency, "lib"), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ version }));
    const bundle = join(dependency, "lib/coreBundle.js");
    writeFileSync(bundle, pristine);
    const script = join(root, "bin/patch-patchright.mjs");
    copyFileSync(fileURLToPath(patchUrl), script);
    const link = join(root, "install.mjs");
    symlinkSync(script, link);
    const child = spawnSync(process.execPath, [link], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /fixes installed/);
    assert.equal(readFileSync(bundle, "utf8"), patchDependencySource(pristine, version));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upstream network backport removes per-request listeners and dispatches the matching response", async () => {
  function methods(source: string): { Route: any; paused: Function } {
    const start = source.indexOf("    RouteImpl = class {");
    const end = source.indexOf("\n    errorReasons =", start);
    assert.ok(start >= 0 && end > start);
    const definition = source.slice(start + "    RouteImpl = ".length, end).trim().replace(/;$/, "");
    const Route = Function("eventsHelper", `return (${definition})`)({
      addEventListener: (emitter: EventEmitter, name: string, callback: (...args: any[]) => void) => emitter.on(name, callback),
    });
    const a = source.indexOf("      _onRequestPaused(sessionInfo, event) {");
    const b = source.indexOf("\n      _onRequest(requestWillBeSentSessionInfo", a);
    assert.ok(a >= 0 && b > a);
    const paused = Function(`return (function ${source.slice(a, b).trim()})`)();
    return { Route, paused };
  }
  const old = methods(pristine), fixed = methods(patchDependencySource(pristine, version));
  const before = new EventEmitter(); before.setMaxListeners(0);
  const oldManager = { _alreadyTrackedNetworkIds: new Set() };
  for (let i = 0; i < 1000; i++) new old.Route(before, `f${i}`, {}, `n${i}`, oldManager);
  assert.equal(before.listenerCount("Fetch.requestPaused"), 1000, "negative control reproduces upstream #245");

  const session = new EventEmitter(); session.setMaxListeners(0);
  const manager = {
    _alreadyTrackedNetworkIds: new Set(["n7"]),
    _requestIdToRequest: new Map(),
    _requestIdToRequestWillBeSentEvent: new Map(),
    _requestIdToRequestPausedEvent: new Map(),
  };
  let fulfilled = 0, sends = 0;
  Object.assign(session, { send: async () => { sends++; return { body: "offline-body" }; } });
  for (let i = 0; i < 1000; i++) {
    const route = new fixed.Route(session, `f${i}`, {}, `n${i}`, manager);
    if (i === 7) {
      route.fulfill = async () => { fulfilled++; };
      manager._requestIdToRequest.set("n7", { _originalRequestRoute: route });
    }
  }
  assert.equal(session.listenerCount("Fetch.requestPaused"), 0);
  await fixed.paused.call(manager, { session }, { networkId: "n7", requestId: "f7", resourceType: "Document", responseStatusCode: 200 });
  assert.equal(fulfilled, 1);
  assert.equal(sends, 1);
  assert.equal(manager._alreadyTrackedNetworkIds.size, 0);
  fixed.paused.call(manager, { session }, { networkId: "ordinary", requestId: "f-ordinary", request: { url: "https://example.invalid/" } });
  assert.equal(manager._requestIdToRequestPausedEvent.size, 1, "untracked requests keep their original pairing path");
  assert.equal(patchDependencySource(patchDependencySource(pristine, version), version), patchDependencySource(pristine, version));
});

interface Outcome {
  calls: number;
  error: string | null;
  contextReturned: boolean;
  timerFiredBeforeSettlement: boolean;
  timerFired: boolean;
}
function probe(unpatched = false): unknown {
  const fixture = fileURLToPath(new URL("./fixtures/patchright-context-recovery.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", fixture, ...(unpatched ? ["--unpatched"] : [])], {
    encoding: "utf8", timeout: 6_000, killSignal: "SIGKILL",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("unpatched dependency reproduces terminal-session recursion and timer starvation", () => {
  const result = probe(true) as Outcome;
  assert.equal(result.calls, 10_000);
  assert.equal(result.error, "Frame was detached");
  assert.equal(result.timerFiredBeforeSettlement, false);
  assert.equal(result.timerFired, true);
});

test("terminal sessions reject promptly in every world; transient navigation and healthy sessions still work", () => {
  const results = probe() as Record<string, Outcome>;
  for (const terminal of ["crashed", "closed", "disconnected", "disconnect-logs"]) {
    for (const world of ["main", "utility", "child"]) {
      const result = results[`${terminal}:${world}`];
      assert.equal(result.calls, 0);
      assert.equal(result.error, terminal === "crashed" ? "crashed" : "closed");
      assert.equal(result.timerFired, true);
    }
  }
  assert.equal(results.duringSend.calls, 1);
  assert.equal(results.duringSend.error, "crashed");
  assert.equal(results.transient.calls, 2);
  assert.equal(results.transient.error, null);
  for (const name of ["transient", "healthyMain", "healthyUtility", "healthyChild"]) {
    assert.equal(results[name].contextReturned, true);
    assert.equal(results[name].timerFired, true);
  }
});
