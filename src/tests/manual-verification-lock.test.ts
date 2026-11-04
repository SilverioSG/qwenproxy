/**
 * Manual verification must own the profile while it closes the headless
 * context and opens the visible browser. The standby/warmup skips accounts
 * marked temporarily busy (the flag the manual flow sets), so it cannot
 * recreate SingletonLock in that window.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  clearTemporaryBusy,
  isAccountTemporarilyBusy,
  markAccountTemporarilyBusy,
} from "../core/account-concurrency.ts";

const ids: string[] = [];
function id(tag: string) {
  const value = `lockfix-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  ids.push(value);
  return value;
}

after(() => {
  for (const value of ids) clearTemporaryBusy(value);
});

test("temporarily-busy flag is the manual-verification exclusion primitive", () => {
  const account = id("busy");
  assert.equal(isAccountTemporarilyBusy(account), false);
  markAccountTemporarilyBusy(account, 60_000);
  assert.equal(isAccountTemporarilyBusy(account), true);
  clearTemporaryBusy(account);
  assert.equal(isAccountTemporarilyBusy(account), false);
});

test("manual verification sets the busy flag it expects the warmup to honor", () => {
  const manual = fs.readFileSync(
    path.resolve("src/services/manual-verification.ts"),
    "utf-8",
  );
  assert.ok(manual.includes("markAccountTemporarilyBusy"));
});

test("standby/warmup skips temporarily-busy accounts before init", () => {
  const server = fs.readFileSync(path.resolve("src/api/server.ts"), "utf-8");
  const start = server.indexOf("async function prepareAccountRuntime(");
  assert.ok(start >= 0, "prepareAccountRuntime must exist");
  const body = server.slice(start, start + 1600);
  assert.ok(
    body.includes("isAccountTemporarilyBusy(account.id)"),
    "warmup must skip accounts marked temporarily busy",
  );
});
