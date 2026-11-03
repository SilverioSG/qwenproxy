import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../core/config.ts";
import {
  acquireAccountLease,
  markAccountTemporarilyBusy,
  clearTemporaryBusy,
  resetAccountConcurrencyForTests,
} from "../core/account-concurrency.ts";
import {
  closeIdlePlaywrightAccounts,
  evictIdlePlaywrightContextsToLimit,
  closePlaywrightForAccount,
  getIdlePlaywrightAccountIds,
  isPlaywrightInitialized,
  registerPlaywrightAccountForTests,
} from "../services/playwright.ts";
import {
  isSessionKeeperRunning,
  runSessionKeeperOnceForTesting,
  startSessionKeeper,
  stopSessionKeeper,
} from "../services/session-keeper.ts";

const IDLE_MS = 60_000;
const STALE_ACTIVITY_AT = Date.now() - 10 * 60_000;

/** The idle sweep only needs the page to exist in the account map. */
function stubPage(): any {
  return { isClosed: () => false, url: () => "https://chat.qwen.ai/" };
}

test("session keeper starts and stops safely", () => {
  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);

  startSessionKeeper();
  assert.equal(
    isSessionKeeperRunning(),
    config.sessionKeeper.enabled || config.playwright.idleContextTtlMs > 0,
  );

  stopSessionKeeper();
  assert.equal(isSessionKeeperRunning(), false);
});

test("session keeper one-shot cycle is safe without initialized accounts", async () => {
  stopSessionKeeper();
  await runSessionKeeperOnceForTesting();
  assert.equal(isSessionKeeperRunning(), false);
});

test("idle sweep preserves the only warm context when max active contexts is 1", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const accountId = "idle-preserve";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);

  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), [accountId]);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(accountId);
  }
});

test("idle sweep closes an idle context when no warm context must be preserved", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 0;
  const accountId = "idle-no-lease";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);

  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), [accountId]);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 1);
    assert.equal(isPlaywrightInitialized(accountId), false);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
  }
});

test("idle sweep never closes a context that holds a stream lease", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 0;
  const accountId = "idle-with-lease";

  try {
    // A browser generation performs no page operation, so its last activity is
    // as old as the request itself — the exact shape of a >TTL generation.
    registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);
    const lease = await acquireAccountLease(accountId);

    try {
      assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), []);
      assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
      assert.equal(isPlaywrightInitialized(accountId), true);
    } finally {
      lease.release();
    }

    // The sweep refreshed the idle clock while the stream was alive, so the
    // context is not collectable the moment the lease is released either.
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

test("idle sweep preserves the account context while manual verification is busy", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 0;
  const accountId = "manual-verification-busy";
  registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);
  markAccountTemporarilyBusy(accountId, 120_000);
  try {
    assert.deepEqual(getIdlePlaywrightAccountIds(IDLE_MS), []);
    assert.equal(await closeIdlePlaywrightAccounts(IDLE_MS), 0);
    assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    clearTemporaryBusy(accountId);
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

test("context limit evicts another idle context instead of the account being verified", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const busy = "manual-verification-busy-limit";
  const idle = "manual-verification-idle-limit";
  registerPlaywrightAccountForTests(idle, stubPage(), STALE_ACTIVITY_AT);
  registerPlaywrightAccountForTests(busy, stubPage(), STALE_ACTIVITY_AT - 1);
  markAccountTemporarilyBusy(busy, 120_000);
  try {
    assert.equal(await evictIdlePlaywrightContextsToLimit(), 1);
    assert.equal(isPlaywrightInitialized(busy), true);
    assert.equal(isPlaywrightInitialized(idle), false);
  } finally {
    clearTemporaryBusy(busy);
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(busy).catch(() => {});
    await closePlaywrightForAccount(idle).catch(() => {});
  }
});

test("context limit preserves all active stream leases even above the limit", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const accounts = ["eviction-stream-a", "eviction-stream-b"];
  for (const accountId of accounts) {
    registerPlaywrightAccountForTests(accountId, stubPage(), STALE_ACTIVITY_AT);
  }
  const leases = await Promise.all(accounts.map((accountId) => acquireAccountLease(accountId)));
  try {
    assert.equal(await evictIdlePlaywrightContextsToLimit(), 0);
    for (const accountId of accounts) assert.equal(isPlaywrightInitialized(accountId), true);
  } finally {
    for (const lease of leases) lease.release();
    config.playwright.maxActiveContexts = originalMax;
    for (const accountId of accounts) await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

test("context limit closes the idle context while preserving an active stream", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const active = "eviction-stream-active";
  const idle = "eviction-stream-idle";
  registerPlaywrightAccountForTests(idle, stubPage(), STALE_ACTIVITY_AT);
  registerPlaywrightAccountForTests(active, stubPage(), STALE_ACTIVITY_AT);
  const lease = await acquireAccountLease(active);
  try {
    assert.equal(await evictIdlePlaywrightContextsToLimit(), 1);
    assert.equal(isPlaywrightInitialized(active), true);
    assert.equal(isPlaywrightInitialized(idle), false);
  } finally {
    lease.release();
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(active).catch(() => {});
    await closePlaywrightForAccount(idle).catch(() => {});
  }
});

test("context eviction preserves a stream lease acquired while closure waits for its mutex", async () => {
  resetAccountConcurrencyForTests();
  const originalMax = config.playwright.maxActiveContexts;
  config.playwright.maxActiveContexts = 1;
  const idle = "eviction-race-other";
  const target = "eviction-race-new-lease";
  registerPlaywrightAccountForTests(idle, stubPage(), STALE_ACTIVITY_AT);
  registerPlaywrightAccountForTests(target, stubPage(), STALE_ACTIVITY_AT);
  const eviction = evictIdlePlaywrightContextsToLimit();
  const lease = await acquireAccountLease(target);
  try {
    await eviction;
    assert.equal(isPlaywrightInitialized(target), true);
  } finally {
    lease.release();
    config.playwright.maxActiveContexts = originalMax;
    await closePlaywrightForAccount(target).catch(() => {});
    await closePlaywrightForAccount(idle).catch(() => {});
  }
});

// ── shutdown race: closeAllPlaywright closes contexts while a keep-alive
// cycle is in flight; the resulting "already closed" rejection is benign and
// must NOT leak a warning (the user saw it on Ctrl+C).
function closedGotoPage(message: string): any {
  return {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    goto: async () => {
      throw new Error(message);
    },
  };
}

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
  return { warns, restore: () => { console.warn = original; } };
}

test("keep-alive suppresses the benign already-closed error on shutdown", async () => {
  resetAccountConcurrencyForTests();
  stopSessionKeeper();
  const accountId = "keeper-closed-race";
  registerPlaywrightAccountForTests(
    accountId,
    closedGotoPage(
      "page.goto: Target page, context or browser has been closed\nCall log:\nnavigating to https://chat.qwen.ai/",
    ),
    STALE_ACTIVITY_AT,
  );
  const captured = captureWarns();
  try {
    await runSessionKeeperOnceForTesting();
    assert.equal(
      captured.warns.filter((w) => w.includes("Keep-alive failed")).length,
      0,
      `already-closed must be silent, got: ${captured.warns.join(" | ")}`,
    );
  } finally {
    captured.restore();
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});

test("keep-alive still warns for real errors (no over-suppression)", async () => {
  resetAccountConcurrencyForTests();
  stopSessionKeeper();
  const accountId = "keeper-real-error";
  registerPlaywrightAccountForTests(
    accountId,
    closedGotoPage("page.goto: net::ERR_CONNECTION_RESET"),
    STALE_ACTIVITY_AT,
  );
  const captured = captureWarns();
  try {
    await runSessionKeeperOnceForTesting();
    assert.ok(
      captured.warns.some((w) => w.includes("Keep-alive failed")),
      "a non-closed error must still be reported",
    );
  } finally {
    captured.restore();
    await closePlaywrightForAccount(accountId).catch(() => {});
  }
});
