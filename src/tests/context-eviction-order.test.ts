import test from "node:test";
import assert from "node:assert";

import {
  orderContextsForEviction, evictIdlePlaywrightContextsToLimit,
  registerPlaywrightAccountForTests, unregisterPlaywrightAccountForTests, isPlaywrightInitialized,
} from "../services/playwright.ts";
import { config } from "../core/config.ts";
import { tryAcquireAccountLease } from "../core/account-concurrency.ts";
import { markAccountRateLimited, clearAccountCooldown } from "../core/account-manager.ts";

test("context eviction order: unranked first, then lowest priority, then oldest activity", () => {
  const rank = new Map<string, number>([
    ["p1", 0], // highest priority
    ["p2", 1],
    ["p3", 2], // lowest priority
  ]);
  const activity = new Map<string, number>([
    ["p1", 300],
    ["p2", 200],
    ["p3", 100],
    ["unranked", 50],
  ]);

  const order = orderContextsForEviction(
    ["p1", "p2", "p3", "unranked"],
    (id) => rank.get(id),
    (id) => activity.get(id) ?? 0,
  );

  // Unranked (unknown) accounts are evicted before ranked ones; among ranked,
  // the lowest priority goes first; ties break by oldest activity.
  assert.deepStrictEqual(order, ["unranked", "p3", "p2", "p1"]);
});

test("context eviction order: no rank data falls back to activity order", () => {
  const activity = new Map<string, number>([
    ["old", 100],
    ["recent", 500],
  ]);
  const order = orderContextsForEviction(
    ["recent", "old"],
    () => undefined,
    (id) => activity.get(id) ?? 0,
  );
  assert.deepStrictEqual(order, ["old", "recent"]);
});

test("context eviction order: same priority keeps the recently used context", () => {
  const rank = new Map<string, number>([["a", 1], ["b", 1]]);
  const activity = new Map<string, number>([
    ["a", 100],
    ["b", 400],
  ]);
  const order = orderContextsForEviction(
    ["a", "b"],
    (id) => rank.get(id),
    (id) => activity.get(id) ?? 0,
  );
  // b was used most recently -> survives, a is evicted first.
  assert.deepStrictEqual(order, ["a", "b"]);
});

test("context admission can reserve the last slot, including max=1, while preserving a live lease", async () => {
  const previous = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const idle = "admission-idle", busy = "admission-busy";
  const page = () => ({ isClosed: () => false, url: () => "https://chat.qwen.ai/", close: async () => {} } as any);
  registerPlaywrightAccountForTests(idle, page(), Date.now());
  registerPlaywrightAccountForTests(busy, page(), Date.now());
  const lease = tryAcquireAccountLease(busy, "offline-admission");
  assert.ok(lease);
  try {
    assert.equal(await evictIdlePlaywrightContextsToLimit(0), 1);
    assert.equal(isPlaywrightInitialized(idle), false);
    assert.equal(isPlaywrightInitialized(busy), true);
    lease.release();
    assert.equal(await evictIdlePlaywrightContextsToLimit(0), 1);
    assert.equal(isPlaywrightInitialized(busy), false);
  } finally {
    lease.release();
    unregisterPlaywrightAccountForTests(idle);
    unregisterPlaywrightAccountForTests(busy);
    config.playwright.maxActiveContexts = previous;
  }
});

test("context eviction prioritizes a cooldown account even when it was most recently used", async () => {
  const previous = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 2;
  // The cooling account is first (highest fallback priority), so an
  // unchanged priority-only eviction would incorrectly close a healthy one.
  const ids = ["rotation-cooling", "rotation-healthy-a", "rotation-healthy-b"];
  ids.forEach((id, i) => registerPlaywrightAccountForTests(id, {
    isClosed: () => false, url: () => "https://chat.qwen.ai/", close: async () => {},
  } as any, Date.now() - (i + 1) * 1000));
  markAccountRateLimited(ids[0], 60_000, "RateLimited", { silent: true });
  try {
    assert.equal(await evictIdlePlaywrightContextsToLimit(), 1);
    assert.equal(isPlaywrightInitialized(ids[0]), false);
    assert.equal(isPlaywrightInitialized(ids[1]), true);
    assert.equal(isPlaywrightInitialized(ids[2]), true);
  } finally {
    clearAccountCooldown(ids[0]);
    ids.forEach(unregisterPlaywrightAccountForTests);
    config.playwright.maxActiveContexts = previous;
  }
});
