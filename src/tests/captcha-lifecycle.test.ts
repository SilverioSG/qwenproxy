/**
 * Human-captcha lifecycle: deadline coordination + cancellation (Fix D).
 *
 * Contract:
 * - the normal attempt deadline stays 120s when no captcha appears, and the
 *   captcha hook never fires for non-captcha requests;
 * - the human budget is 300s; the attempt-deadline controller can be
 *   re-armed (single timer, replace-not-add) so a solve past 120s is possible;
 * - the waiter honors AbortSignal: pre-aborted returns at once with zero
 *   page operations; mid-wait abort cuts the 2s sleep short and starts no
 *   further polls (no orphan polling after acquire_deadline);
 * - a simulated solve ends the wait with solved:true and the fresh jar;
 * - an unsolved wait ends exactly on the human timeout with full cleanup.
 *
 * No browser: the account-page runner is faked (repo-precedented seam).
 * No network. Secrets never asserted by value beyond in-test constants.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../core/config.ts";
import { createAttemptDeadline } from "../routes/chat/account.ts";
import {
  createStreamForAccount,
  type StreamFactoryResult,
} from "../services/qwen-transport-dispatch.ts";
import {
  _setAccountPageRunnerForTests,
  HUMAN_CAPTCHA_BUDGET_MS,
  recoverWithHumanCaptcha,
  waitForHumanCaptchaClearance,
} from "../services/qwen-human-captcha.ts";
import { _resetAccountSessionsForTests } from "../services/qwen-account-session.ts";

const LS_TOKEN = "ls-token-for-captcha-lifecycle-tests";
const CLEARANCE = "fresh-clearance-value-abc";

function futureExpSec(): number {
  return Math.floor(Date.now() / 1000) + 900;
}

function jarWith(x5sec: string | null): Array<Record<string, unknown>> {
  const cookies: Array<Record<string, unknown>> = [
    { name: "cna", value: "x", domain: ".qwen.ai", path: "/", expires: -1 },
  ];
  if (x5sec !== null) {
    cookies.push({
      name: "x5sec",
      value: x5sec,
      domain: "chat.qwen.ai",
      path: "/",
      expires: futureExpSec(),
    });
  }
  return cookies;
}

/** Fake runner serving a per-poll cookie script; counts invocations. */
function installRunner(
  script: Array<{ x5sec: string | null }>,
  calls: { n: number },
): void {
  _setAccountPageRunnerForTests(async (_accountId, fn) => {
    calls.n += 1;
    const step = script[Math.min(calls.n - 1, script.length - 1)] ?? {
      x5sec: null,
    };
    const page = {
      isClosed: () => false,
      context: () => ({
        cookies: async () => jarWith(step.x5sec),
      }),
      evaluate: async () => ({
        token: LS_TOKEN,
        userAgent: "Mozilla/5.0 Test",
      }),
    };
    return fn(page as never);
  });
}

function cleanupRunner(): void {
  _setAccountPageRunnerForTests(null);
  _resetAccountSessionsForTests();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── TEST 1: normal request deadline unchanged, hook never fires ─────────────

test("no captcha: legacy fallback runs, captcha hook never fires", async () => {
  let hookCalls = 0;
  const fake = {
    stream: new ReadableStream(),
    headers: {},
    uiSessionId: "u1",
    controller: new AbortController(),
    accountId: "a1",
    createdNewChat: true,
    tokenEstimationContext: {},
  } as unknown as StreamFactoryResult;
  const out = await createStreamForAccount(
    {
      prompt: "hi",
      isThinkingModel: false,
      model: "qwen3.8-max",
      onCaptchaStart: () => {
        hookCalls += 1;
      },
    },
    async () => fake,
  );
  assert.equal(out, fake);
  assert.equal(hookCalls, 0);
  assert.equal(config.concurrency.acquireDeadlineMs, 120_000);
  assert.equal(HUMAN_CAPTCHA_BUDGET_MS, 300_000);
});

// ── TEST 2: single-timer re-arm extends, replaces, clears ────────────────────

test("attempt deadline: fires once, re-arm replaces, clear prevents", async () => {
  let fires = 0;
  const d = createAttemptDeadline(() => {
    fires += 1;
  });
  d.extend(30);
  await sleep(80);
  assert.equal(fires, 1);
  d.clear();

  fires = 0;
  const d2 = createAttemptDeadline(() => {
    fires += 1;
  });
  d2.extend(30);
  await sleep(10);
  d2.extend(300);
  await sleep(80);
  assert.equal(fires, 0);
  await sleep(280);
  assert.equal(fires, 1);
  d2.clear();

  fires = 0;
  const d3 = createAttemptDeadline(() => {
    fires += 1;
  });
  d3.extend(30);
  d3.clear();
  await sleep(80);
  assert.equal(fires, 0);
});

// ── TEST 3: abort propagation ────────────────────────────────────────────────

test("pre-aborted waiter returns at once with zero page operations", async () => {
  const calls = { n: 0 };
  installRunner([{ x5sec: null }], calls);
  try {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const res = await waitForHumanCaptchaClearance("captcha-acct-1", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    assert.ok(Date.now() - start < 1_000);
    assert.equal(res.solved, false);
    assert.equal(res.reason, "aborted");
    assert.equal(calls.n, 0);
  } finally {
    cleanupRunner();
  }
});

test("mid-wait abort cuts the sleep short and starts no new poll", async () => {
  const calls = { n: 0 };
  installRunner([{ x5sec: null }], calls);
  try {
    const controller = new AbortController();
    const pending = waitForHumanCaptchaClearance("captcha-acct-2", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await sleep(200);
    controller.abort();
    const start = Date.now();
    const res = await pending;
    assert.ok(Date.now() - start < 1_500);
    assert.equal(res.solved, false);
    assert.equal(res.reason, "aborted");
    assert.equal(calls.n, 0);
  } finally {
    cleanupRunner();
  }
});

// ── TEST 4: polling cleanup ──────────────────────────────────────────────────

test("after abort, zero further polls (no orphan waiter)", async () => {
  const calls = { n: 0 };
  installRunner([{ x5sec: null }], calls);
  try {
    const controller = new AbortController();
    const pending = waitForHumanCaptchaClearance("captcha-acct-3", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await sleep(200);
    controller.abort();
    await pending;
    const frozen = calls.n;
    await sleep(2_500);
    assert.equal(calls.n, frozen);
  } finally {
    cleanupRunner();
  }
});

// ── TEST 5: simulated human solve ────────────────────────────────────────────

test("clearance change ends the wait solved with the fresh jar", async () => {
  const calls = { n: 0 };
  installRunner(
    [{ x5sec: null }, { x5sec: null }, { x5sec: CLEARANCE }],
    calls,
  );
  try {
    const res = await waitForHumanCaptchaClearance("captcha-acct-4", {
      timeoutMs: 60_000,
      baseline: { present: false, hash: null, expiresAt: 0 },
    });
    assert.equal(res.solved, true);
    assert.equal(res.reason, null);
    assert.ok(res.waitedMs >= 4_000);
    assert.ok(calls.n >= 3);
  } finally {
    cleanupRunner();
  }
});

// ── recover: pre-aborted skips everything ────────────────────────────────────

test("recover with pre-aborted signal performs no page operations", async () => {
  const calls = { n: 0 };
  installRunner([{ x5sec: CLEARANCE }], calls);
  try {
    const controller = new AbortController();
    controller.abort();
    const out = await recoverWithHumanCaptcha("captcha-acct-5", {
      challengeBody: "",
      signal: controller.signal,
    });
    assert.equal(out.solved, false);
    assert.equal(out.cookieHeader, null);
    assert.equal(calls.n, 0);
  } finally {
    cleanupRunner();
  }
});

// ── TEST 6: human timeout ends exactly on budget with full cleanup ───────────

test("unsolved wait ends on the human timeout, then goes quiet", async () => {
  const calls = { n: 0 };
  installRunner([{ x5sec: null }], calls);
  try {
    const start = Date.now();
    const res = await waitForHumanCaptchaClearance("captcha-acct-6", {
      timeoutMs: 5_000,
    });
    const elapsed = Date.now() - start;
    assert.equal(res.solved, false);
    assert.equal(res.reason, "human-solve-timeout");
    assert.ok(elapsed >= 5_000 && elapsed < 9_000);
    const frozen = calls.n;
    assert.ok(frozen >= 1);
    await sleep(2_500);
    assert.equal(calls.n, frozen);
  } finally {
    cleanupRunner();
  }
});
