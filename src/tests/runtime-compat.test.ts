import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  affectedAsyncStackV8Versions,
  asyncStackGuardEnabled,
} from "../core/runtime-compat.ts";

const fixture = fileURLToPath(new URL("./fixtures/async-stack-cycle.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../../", import.meta.url));

function checkCapture(args: string[]) {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--env-file=.env.test", fixture, ...args,
  ], { cwd, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CAPTURE_DONE/);
  assert.match(result.stdout, /EVENT_LOOP_ALIVE/);
}

test("config initialization preserves synchronous stacks and promise execution", () => {
  checkCapture(["--acyclic"]);
});

test("affected V8 terminates stack capture with cyclic promise reactions", {
  skip: !affectedAsyncStackV8Versions.has(process.versions.v8),
}, () => {
  checkCapture([]);
});

test("guard allowlist covers exactly the verified runtimes", () => {
  assert.equal(affectedAsyncStackV8Versions.has("14.6.202.34-node.28"), true);
  assert.equal(affectedAsyncStackV8Versions.has("14.6.202.34-node.34"), true);
  assert.equal(affectedAsyncStackV8Versions.size, 2);
  assert.equal(affectedAsyncStackV8Versions.has("14.6.202.34-node.99"), false);
  assert.equal(affectedAsyncStackV8Versions.has("14.7.0"), false);
  assert.equal(affectedAsyncStackV8Versions.has(""), false);
});

test("guard flag matches the allowlist on this runtime", () => {
  assert.equal(
    asyncStackGuardEnabled,
    affectedAsyncStackV8Versions.has(process.versions.v8),
  );
});
