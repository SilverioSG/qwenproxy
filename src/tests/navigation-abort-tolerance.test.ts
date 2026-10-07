/**
 * Port validation for upstream johngbl deb878d (v1.4.1):
 * "Fix net::ERR_ABORTED on account rotation by awaiting initial navigation
 *  and handling benign aborts".
 *
 * Contract:
 * 1. page.goto throws net::ERR_ABORTED while the page is already on the
 *    target origin  => benign, swallow, operation continues (no
 *    PersonalizationSyncError, no 300s cooldown).
 * 2. page.goto throws net::ERR_ABORTED while the page is OFF-origin
 *    (about:blank, auth host, ...) => rethrow.
 * 3. Target closed / browser closed / context closed => rethrow (never
 *    mistaken for a benign abort).
 * 4. Timeouts and connection errors => rethrow.
 * 5. restoredFromDb init navigation is awaited, not fire-and-forget, so it
 *    cannot overlap the next page.goto on the same page.
 * 6. A REAL personalization rejection still maps to PersonalizationFailed
 *    with the legitimate cooldown (no over-tolerance).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  _withQwenBrowserPageForTests,
  isBenignNavigationAbort,
} from "../services/qwen.ts";
import {
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} from "../services/playwright.ts";
import { PersonalizationSyncError } from "../services/qwen-errors.ts";
import { classifyRetryAction } from "../routes/chat/retry-policy.ts";
import { config } from "../core/config.ts";

const ORIGIN = "https://chat.qwen.ai";
const ROOT = "https://chat.qwen.ai/";

function abortError(): Error {
  return new Error(`page.goto: net::ERR_ABORTED at ${ROOT}`);
}

/** Mutable URL holder so a fake goto can "commit" the navigation. */
function holder(startUrl: string): { url: string } {
  return { url: startUrl };
}

function fakePageWithHolder(
  current: { url: string },
  goto: (url: string) => Promise<void>,
): any {
  return {
    url: () => current.url,
    isClosed: () => false,
    goto,
  };
}

// ─── Predicate matrix ───────────────────────────────────────────────────────

test("predicate: ERR_ABORTED on the target origin is benign", () => {
  assert.equal(isBenignNavigationAbort(abortError(), ROOT, ORIGIN), true);
  assert.equal(
    isBenignNavigationAbort(abortError(), `${ORIGIN}/c/abc123`, ORIGIN),
    true,
  );
});

test("predicate: ERR_ABORTED off-origin is NOT benign", () => {
  assert.equal(isBenignNavigationAbort(abortError(), "about:blank", ORIGIN), false);
  assert.equal(
    isBenignNavigationAbort(abortError(), "https://auth.qwen.ai/login", ORIGIN),
    false,
  );
  assert.equal(isBenignNavigationAbort(abortError(), "", ORIGIN), false);
});

test("predicate: non-abort failures are never benign, even on-origin", () => {
  const onOrigin = ROOT;
  assert.equal(
    isBenignNavigationAbort(
      new Error("Target page, context or browser has been closed"),
      onOrigin,
      ORIGIN,
    ),
    false,
  );
  assert.equal(
    isBenignNavigationAbort(new Error("Browser has been closed"), onOrigin, ORIGIN),
    false,
  );
  assert.equal(
    isBenignNavigationAbort(new Error("Timeout 60000ms exceeded."), onOrigin, ORIGIN),
    false,
  );
  assert.equal(
    isBenignNavigationAbort(
      new Error("page.goto: net::ERR_FAILED at https://chat.qwen.ai/"),
      onOrigin,
      ORIGIN,
    ),
    false,
  );
  assert.equal(
    isBenignNavigationAbort(
      new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://chat.qwen.ai/"),
      onOrigin,
      ORIGIN,
    ),
    false,
  );
  assert.equal(isBenignNavigationAbort(null, onOrigin, ORIGIN), false);
  assert.equal(isBenignNavigationAbort(undefined, onOrigin, ORIGIN), false);
  // A non-Error thrown value carrying the marker still counts when on-origin.
  assert.equal(
    isBenignNavigationAbort(`page.goto: net::ERR_ABORTED at ${ROOT}`, onOrigin, ORIGIN),
    true,
  );
});

// ─── Behavioral: withQwenBrowserPage ────────────────────────────────────────

async function runWithFakePage(
  accountId: string,
  current: { url: string },
  goto: (url: string) => Promise<void>,
): Promise<string> {
  const page = fakePageWithHolder(current, goto);
  registerPlaywrightAccountForTests(accountId, page, Date.now());
  try {
    return await _withQwenBrowserPageForTests(
      accountId,
      async () => "continued",
      undefined,
      10_000,
      false,
    );
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
}

test("behavior: benign ERR_ABORTED lets the operation continue", async () => {
  const accountId = "abort-benign";
  const current = holder("about:blank");
  let gotoCalls = 0;
  const result = await runWithFakePage(accountId, current, async (url) => {
    gotoCalls++;
    // Chromium committed to the target before reporting the abort.
    current.url = url;
    throw abortError();
  });
  assert.equal(result, "continued");
  assert.equal(gotoCalls, 1);
});

test("behavior: ERR_ABORTED off-origin rethrows", async () => {
  const accountId = "abort-offorigin";
  const current = holder("about:blank");
  await assert.rejects(
    runWithFakePage(accountId, current, async () => {
      // Page never left about:blank.
      throw abortError();
    }),
    /ERR_ABORTED/,
  );
});

test("behavior: Target closed rethrows even on-origin", async () => {
  const accountId = "abort-targetclosed";
  const current = holder("about:blank");
  await assert.rejects(
    runWithFakePage(accountId, current, async () => {
      throw new Error("Target page, context or browser has been closed");
    }),
    /Target page, context or browser has been closed/,
  );
});

test("behavior: navigation timeout rethrows", async () => {
  const accountId = "abort-timeout";
  const current = holder("about:blank");
  await assert.rejects(
    runWithFakePage(accountId, current, async () => {
      throw new Error("Timeout 60000ms exceeded.");
    }),
    /Timeout 60000ms exceeded/,
  );
});

test("behavior: no navigation when already home; goto untouched", async () => {
  const accountId = "abort-noop";
  const current = holder(ROOT);
  let gotoCalls = 0;
  const result = await runWithFakePage(accountId, current, async () => {
    gotoCalls++;
  });
  assert.equal(result, "continued");
  assert.equal(gotoCalls, 0);
});

// ─── Structural: restoredFromDb navigation is awaited ───────────────────────

test("structure: restoredFromDb navigation is awaited, not fire-and-forget", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  assert.ok(
    !src.includes("void acctPage.goto"),
    "fire-and-forget void acctPage.goto must be gone",
  );
  const start = src.indexOf("if (restoredFromDb) {");
  assert.ok(start >= 0, "restoredFromDb block not found");
  const block = src.slice(start, src.indexOf("return;", start) + 8);
  assert.ok(block.includes("await acctPage.goto"), "navigation must be awaited");
  assert.ok(block.includes("await sleep(300)"), "settle delay must survive");
  assert.ok(
    block.includes('includes("ERR_ABORTED")'),
    "benign-abort tolerance must survive",
  );
});

// ─── No over-tolerance: real failures keep their semantics ──────────────────

test("semantics: real personalization rejection still cools the account down", () => {
  const policy = classifyRetryAction(
    new PersonalizationSyncError(
      "personalization sync not confirmed: settings response did not confirm the instruction",
    ),
    {},
  );
  assert.equal(policy.reason, "personalization_sync_failed");
  assert.equal(policy.accountCooldownReason, "PersonalizationFailed");
  assert.equal(
    policy.accountCooldownMs,
    config.concurrency.initFailureCooldownMs,
  );
});
