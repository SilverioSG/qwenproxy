import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

process.env.TEST_MOCK_QWEN_AUTH = "false";
const {
  getBasicHeaders, getTokenDiagnostics, refreshHeaders, withAccountPage,
  registerPlaywrightAccountForTests, unregisterPlaywrightAccountForTests,
} = await import("../services/playwright.ts");
const { tryAcquireAccountLease } = await import("../core/account-concurrency.ts");
const { unmarkAccountHeadersReady } = await import("../core/account-manager.ts");

function fixture(id: string) {
  let navigations = 0;
  let finished = false;
  let rejectNavigation!: (error: Error) => void;
  const pendingNavigation = new Promise<void>((_, reject) => { rejectNavigation = reject; });
  // The rejection is observed by the production refresh when it starts.
  void pendingNavigation.catch(() => {});
  const context: any = { cookies: async () => [{ name: "token", value: "fixture-token", domain: "chat.qwen.ai", expires: -1 }] };
  const page: any = {
    isClosed: () => false, context: () => context, url: () => "https://chat.qwen.ai/",
    evaluate: async () => ({ ua: "offline-UA", secChUa: "", platform: "Linux", mobile: "?0" }),
    goto: () => { navigations++; return pendingNavigation; },
  };
  registerPlaywrightAccountForTests(id, page, Date.now(), context, {
    headers: { cookie: "token=fixture-token", "user-agent": "offline-UA", "bx-v": "2.5.37", "bx-ua": "offline", "bx-umidtoken": "offline" },
    lastRefresh: Date.now() - 21 * 60 * 60 * 1000, // Between 80% TTL and expiry.
  });
  async function finish() {
    if (finished) return;
    rejectNavigation(new Error("offline probe finished"));
    // Drain the same mutex before clearing the fixture's state.
    await withAccountPage(id, async () => {}, 1500, 1500, false);
    unregisterPlaywrightAccountForTests(id);
    unmarkAccountHeadersReady(id);
    finished = true;
  }
  return { get navigations() { return navigations; }, finish };
}

test("proactive header refresh runs and holds the page mutex without suppressing its own in-progress flag", async () => {
  const id = "background-header-progress", f = fixture(id);
  try {
    await getBasicHeaders(id);
    await wait(0);
    assert.equal(f.navigations, 1, "old code silently skipped every proactive refresh");
    const state = await getTokenDiagnostics(id);
    assert.equal(state.headers[0].refreshInProgress, true);
    let entered = false;
    const queued = withAccountPage(id, async () => { entered = true; }, 1500, 1500, false);
    await wait(0);
    assert.equal(entered, false, "background navigation must retain the page mutex");
    await f.finish();
    await queued;
  } finally {
    await f.finish();
  }
});

test("proactive header refresh skips an active account lease", async () => {
  const id = "background-header-active", f = fixture(id);
  const lease = tryAcquireAccountLease(id, "offline-active");
  assert.ok(lease);
  try {
    await getBasicHeaders(id);
    await wait(0);
    assert.equal(f.navigations, 0);
    assert.equal((await getTokenDiagnostics(id)).headers[0].refreshInProgress, false);
  } finally { lease.release(); await f.finish(); }
});

test("queued proactive refresh rechecks a lease claimed while it waited for the page mutex", async () => {
  const id = "background-header-race", f = fixture(id);
  let unlock!: () => void;
  let held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const lock = withAccountPage(id, async () => {
    held();
    await new Promise<void>(resolve => { unlock = resolve; });
  }, 1500, 1500, false);
  await ready;
  const refresh = refreshHeaders(id, 1500, false, { background: true });
  const lease = tryAcquireAccountLease(id, "offline-claimed-during-wait");
  assert.ok(lease);
  try {
    unlock(); await lock; await refresh;
    assert.equal(f.navigations, 0);
  } finally { unlock(); lease.release(); await f.finish(); }
});
