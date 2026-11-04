/**
 * Chromium ProcessSingleton semantics for the manual verification gate.
 *
 * SingletonLock is the ownership marker ("<hostname>-<pid>"). SingletonSocket
 * and SingletonCookie are auxiliary files whose existence alone must NOT block
 * the visible launch (they routinely survive a closed/crashed browser).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { singletonLockPresent } from "../services/manual-verification.ts";

const dirs: string[] = [];
function profile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-lock-"));
  dirs.push(dir);
  return dir;
}
function link(dir: string, name: string, target: string): void {
  fs.symlinkSync(target, path.join(dir, name));
}
after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test("only a residual SingletonCookie is free", () => {
  const dir = profile();
  link(dir, "SingletonCookie", "14550422216044238304");
  assert.equal(singletonLockPresent(dir), false);
});

test("only a residual SingletonSocket is free", () => {
  const dir = profile();
  link(dir, "SingletonSocket", "/tmp/org.chromium.Chromium.X/SingletonSocket");
  assert.equal(singletonLockPresent(dir), false);
});

test("Cookie + Socket residuales are free", () => {
  const dir = profile();
  link(dir, "SingletonCookie", "123");
  link(dir, "SingletonSocket", "/tmp/org.chromium.Chromium.X/SingletonSocket");
  assert.equal(singletonLockPresent(dir), false);
});

test("SingletonLock with a live owner is held", () => {
  const dir = profile();
  link(dir, "SingletonLock", `${os.hostname()}-${process.pid}`);
  assert.equal(singletonLockPresent(dir), true);
});

test("SingletonLock with a dead owner is stale/free", () => {
  const dir = profile();
  const child = spawnSync(process.execPath, ["-e", ""]);
  const deadPid = child.pid;
  assert.ok(deadPid && deadPid > 0);
  link(dir, "SingletonLock", `${os.hostname()}-${deadPid}`);
  assert.equal(singletonLockPresent(dir), false);
});

test("SingletonLock from another host is stale/free", () => {
  const dir = profile();
  link(dir, "SingletonLock", `other-host-${process.pid}`);
  assert.equal(singletonLockPresent(dir), false);
});

test("malformed SingletonLock is free", () => {
  const dir = profile();
  link(dir, "SingletonLock", "not-a-lock");
  assert.equal(singletonLockPresent(dir), false);
});

test("headless closed -> lock removed -> profile available", () => {
  const dir = profile();
  const lock = path.join(dir, "SingletonLock");
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock);
  assert.equal(singletonLockPresent(dir), true);
  fs.unlinkSync(lock);
  assert.equal(singletonLockPresent(dir), false);
});
