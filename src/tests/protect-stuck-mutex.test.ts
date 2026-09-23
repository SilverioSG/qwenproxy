import test from "node:test";
import assert from "node:assert";
import {
  withAccountPage,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
  isPlaywrightInitialized,
} from "../services/playwright.ts";

test("recoverStuckAccountMutex does not destroy context when lock holder is below hold limit", async () => {
  const accountId = "test-protect-hold-" + Date.now();
  const mockPage = { isClosed: () => false };
  registerPlaywrightAccountForTests(accountId, mockPage as any, Date.now());

  let releaseHold: (() => void) | undefined;
  const holdPromise = withAccountPage(
    accountId,
    async () => {
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    },
    5000,
    5000,
    false,
  );

  // Give the hold time to acquire
  await new Promise((r) => setTimeout(r, 50));

  // Now a second call tries with 1000ms timeout and recoverOnTimeout=true
  await assert.rejects(
    () => withAccountPage(accountId, async () => {}, 1000, 1000, true),
    (err: any) => err.message.includes("acquire timeout"),
  );

  // Account should remain registered because holder was only held for ~1s (< 60s)
  assert.strictEqual(
    isPlaywrightInitialized(accountId),
    true,
    "Account context must NOT be destroyed when mutex holder is not genuinely stuck",
  );

  // Release the first lock
  if (releaseHold) releaseHold();
  await holdPromise.catch(() => {});

  // Cleanup
  unregisterPlaywrightAccountForTests(accountId);
});
