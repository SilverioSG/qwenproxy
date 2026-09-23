import test from "node:test";
import assert from "node:assert/strict";

// FIX V1 (fase 2.17B): post-CAPTCHA BrowserContext reset for one account.
// Env set BEFORE the module graph loads (static ESM imports hoist).
process.env.CAPTURE_PROBE = "1";
process.env.CAPTURE_PROBE_HEARTBEAT_MS = "100";
process.env.CAPTURE_PROBE_STALL_MS = "400";

const { maybeResetContextAfterCaptchaRecovery } = await import(
  "../services/qwen.ts"
);
const { QwenNetworkError } = await import("../services/qwen-errors.ts");
const {
  closePlaywrightForAccount,
  getPlaywrightAccountPresence,
  isPlaywrightInitialized,
  registerPlaywrightAccountForTests,
  unregisterPlaywrightAccountForTests,
} = await import("../services/playwright.ts");
const captureProbe = await import("../services/capture-probe.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCapturedLogs(
  fn: () => Promise<unknown>,
): Promise<{ lines: string[]; error?: unknown; result?: unknown }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { lines, result };
  } catch (error) {
    return { lines, error };
  } finally {
    console.log = original;
  }
}

function probeLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes("[CAPTURE-PROBE]"));
}

function stageEvents(lines: string[], stage: string): string[] {
  return probeLines(lines).filter((line) =>
    line.includes(`stage=${stage} `),
  );
}

function countEvent(lines: string[], stage: string, event: string): number {
  return stageEvents(lines, stage).filter((line) =>
    line.includes(`event=${event}`),
  ).length;
}

function makeFakePage() {
  return {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    route: async () => {},
    unroute: async () => {},
    goto: async () => {},
    locator: () => ({ first: () => ({}) }),
    close: async () => {},
  } as any;
}

function registeredAccount(id: string): void {
  registerPlaywrightAccountForTests(id, makeFakePage(), Date.now());
}

// A. CAPTCHA solved -> reset called exactly once, presence clean after.
test("post-captcha reset: solved triggers exactly one close", async () => {
  const accountId = "reset-a-account";
  let closes = 0;
  const order: string[] = [];
  const { lines, error, result } = await withCapturedLogs(async () => {
    const traceId = captureProbe.beginCaptureTrace(accountId);
    try {
      const reset = await maybeResetContextAfterCaptchaRecovery(
        accountId,
        true,
        {
          closeAccount: async (id: string) => {
            assert.equal(id, accountId);
            closes++;
            order.push("close");
          },
          presence: () => ({ context: false, page: false }),
          traceId,
        },
      );
      order.push("reset-returned");
      return reset;
    } finally {
      captureProbe.endCaptureTrace(traceId, "done");
    }
  });
  assert.equal(error, undefined);
  assert.equal(result, true);
  assert.equal(closes, 1, "close must run exactly once on the solved path");
  assert.deepEqual(order, ["close", "reset-returned"]);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ENTER"), 1);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "EXIT"), 1);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ERROR"), 0);
  const exit = stageEvents(lines, "post_captcha_context_reset").find((l) =>
    l.includes("event=EXIT"),
  );
  assert.ok(exit?.includes('result=reset'));
});

// B. CAPTCHA not solved -> no reset, no probes.
test("post-captcha reset: unsolved performs no reset", async () => {
  let closes = 0;
  const { lines, error, result } = await withCapturedLogs(async () => {
    const traceId = captureProbe.beginCaptureTrace("reset-b-account");
    try {
      return await maybeResetContextAfterCaptchaRecovery(
        "reset-b-account",
        false,
        {
          closeAccount: async () => {
            closes++;
          },
          traceId,
        },
      );
    } finally {
      captureProbe.endCaptureTrace(traceId, "done");
    }
  });
  assert.equal(error, undefined);
  assert.equal(result, false);
  assert.equal(closes, 0, "unsolved must not reset");
  assert.equal(probeLines(lines).length, 0, "unsolved must emit no probes");
});

// C. Successful reset drops old state; next access can recreate.
test("post-captcha reset: real close clears old page/context", async () => {
  const accountId = "reset-c-account";
  registeredAccount(accountId);
  try {
    assert.equal(isPlaywrightInitialized(accountId), true);
    const { error, result } = await withCapturedLogs(async () => {
      const traceId = captureProbe.beginCaptureTrace(accountId);
      try {
        return await maybeResetContextAfterCaptchaRecovery(
          accountId,
          true,
          { traceId },
        );
      } finally {
        captureProbe.endCaptureTrace(traceId, "done");
      }
    });
    assert.equal(error, undefined);
    assert.equal(result, true);
    // Old page/context must not be reusable; lazy re-init is possible again.
    assert.equal(isPlaywrightInitialized(accountId), false);
    assert.deepEqual(getPlaywrightAccountPresence(accountId), {
      context: false,
      page: false,
    });
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

// D1. Close throws -> retryable controlled failure, trace ended, ERROR visible.
test("post-captcha reset: close failure throws retryable error", async () => {
  const accountId = "reset-d1-account";
  const { lines, error } = await withCapturedLogs(async () => {
    const traceId = captureProbe.beginCaptureTrace(accountId);
    return await maybeResetContextAfterCaptchaRecovery(accountId, true, {
      closeAccount: async () => {
        throw new Error("close boom");
      },
      traceId,
    });
  });
  assert.ok(
    error instanceof QwenNetworkError,
    "must fail controlled with a retryable QwenNetworkError",
  );
  assert.match((error as Error).message, /refusing to refresh headers/);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ENTER"), 1);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "EXIT"), 0);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ERROR"), 1);
  const errLine = stageEvents(lines, "post_captcha_context_reset").find((l) =>
    l.includes("event=ERROR"),
  );
  assert.ok(errLine?.includes("error=Error"));
  // Trace was ended: further stages on the stale trace must emit nothing.
  const after: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    after.push(args.map(String).join(" "));
  };
  try {
    captureProbe.captureStageEnter("headers_refresh");
  } finally {
    console.log = original;
  }
  assert.equal(
    probeLines(after).length,
    0,
    "ended trace must stay silent on the suspect renderer path",
  );
});

// D2. Close succeeds but old state persists -> refuse to reuse it.
test("post-captcha reset: incomplete invalidation refuses reuse", async () => {
  const accountId = "reset-d2-account";
  let closes = 0;
  const { lines, error } = await withCapturedLogs(async () => {
    const traceId = captureProbe.beginCaptureTrace(accountId);
    return await maybeResetContextAfterCaptchaRecovery(accountId, true, {
      closeAccount: async () => {
        closes++;
      },
      presence: () => ({ context: true, page: true }),
      traceId,
    });
  });
  assert.equal(closes, 1);
  assert.ok(error instanceof QwenNetworkError);
  assert.match((error as Error).message, /reset_incomplete/i);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "EXIT"), 0);
  const errLine = stageEvents(lines, "post_captcha_context_reset").find((l) =>
    l.includes("event=ERROR"),
  );
  assert.ok(errLine?.includes("error=ResetIncomplete"));
});

// E. Resetting account A leaves account B intact.
test("post-captcha reset: other accounts unaffected", async () => {
  const accountA = "reset-e-account-a";
  const accountB = "reset-e-account-b";
  registeredAccount(accountA);
  registeredAccount(accountB);
  try {
    const { error } = await withCapturedLogs(async () => {
      const traceId = captureProbe.beginCaptureTrace(accountA);
      try {
        await maybeResetContextAfterCaptchaRecovery(accountA, true, {
          traceId,
        });
      } finally {
        captureProbe.endCaptureTrace(traceId, "done");
      }
    });
    assert.equal(error, undefined);
    assert.equal(
      isPlaywrightInitialized(accountA),
      false,
      "reset account must be cleared",
    );
    assert.equal(
      isPlaywrightInitialized(accountB),
      true,
      "other account must stay intact",
    );
  } finally {
    unregisterPlaywrightAccountForTests(accountA);
    unregisterPlaywrightAccountForTests(accountB);
  }
});

// F. No mutex regression: release still runs, close is re-entrant.
test("post-captcha reset: mutex released, close re-entrant", async () => {
  const accountId = "reset-f-account";
  registeredAccount(accountId);
  try {
    await closePlaywrightForAccount(accountId);
    assert.equal(isPlaywrightInitialized(accountId), false);
    // A leaked (unreleased) mutex would stall this second close until the
    // 60s acquire timeout; success proves release ran.
    await closePlaywrightForAccount(accountId);
    assert.deepEqual(getPlaywrightAccountPresence(accountId), {
      context: false,
      page: false,
    });
    await sleep(10);
  } finally {
    unregisterPlaywrightAccountForTests(accountId);
  }
});

// G. Probes balanced on success; OFF emits zero logs.
test("post-captcha reset: probes balanced and gated by flag", async () => {
  const accountId = "reset-g-account";
  const { lines, error } = await withCapturedLogs(async () => {
    const traceId = captureProbe.beginCaptureTrace(accountId);
    try {
      await maybeResetContextAfterCaptchaRecovery(accountId, true, {
        closeAccount: async () => {},
        presence: () => ({ context: true, page: true }),
        traceId,
      });
    } catch {
      // Presence mock forces ResetIncomplete; probes still balanced below.
    } finally {
      captureProbe.endCaptureTrace(traceId, "done");
    }
  });
  assert.equal(error, undefined);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ENTER"), 1);
  assert.equal(countEvent(lines, "post_captcha_context_reset", "ERROR"), 1);
  const enter = stageEvents(lines, "post_captcha_context_reset").find((l) =>
    l.includes("event=ENTER"),
  );
  assert.ok(enter?.includes("old_context_present=1"));
  assert.ok(enter?.includes("old_page_present=1"));
  assert.ok(enter?.includes("account=resetgac"));

  const previous = process.env.CAPTURE_PROBE;
  process.env.CAPTURE_PROBE = "0";
  try {
    assert.equal(captureProbe.captureProbeEnabled(), false);
    const off = await withCapturedLogs(() =>
      maybeResetContextAfterCaptchaRecovery("reset-g-off", true, {
        closeAccount: async () => {},
        presence: () => ({ context: false, page: false }),
      }),
    );
    assert.equal(off.error, undefined);
    assert.equal(probeLines(off.lines).length, 0, "probe OFF = 0 logs");
  } finally {
    process.env.CAPTURE_PROBE = previous;
  }
});
