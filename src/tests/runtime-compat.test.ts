import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  skip: process.versions.v8 !== "14.6.202.34-node.28",
}, () => {
  checkCapture([]);
});
