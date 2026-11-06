import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const patchUrl = new URL("../../bin/patch-patchright.mjs", import.meta.url);
const { patchContextSource, installContextPatch, terminalSessionGuard } = await import(patchUrl.href) as {
  patchContextSource(source: string, version: string): string;
  installContextPatch(packagePath?: string): boolean;
  terminalSessionGuard: string;
};
const require = createRequire(import.meta.url);
const packagePath = require.resolve("patchright-core/package.json");
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const installed = readFileSync(join(dirname(packagePath), "lib/coreBundle.js"), "utf8");
const pristine = installed.replace(terminalSessionGuard, "");

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
    assert.equal(readFileSync(bundle, "utf8"), patchContextSource(pristine, version));
    assert.equal(installContextPatch(pkg), false);
    writeFileSync(pkg, JSON.stringify({ version: "unsupported" }));
    const before = readFileSync(bundle, "utf8");
    assert.throws(() => installContextPatch(pkg), /Review the context recovery patch/);
    assert.equal(readFileSync(bundle, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
