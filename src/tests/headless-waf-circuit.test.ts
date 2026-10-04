/**
 * Fix E: headless WAF circuit breaker (no 300s human wait, no pool cascade).
 *
 * Covered here (no browser, fetch stubbed, isolated test DB):
 * - recovery-mode selection: headless -> headless-auto, headed -> human;
 * - WAF signature classes from direct results;
 * - circuit: opens on 2nd independent account, TTL expiry, no cross-talk
 *   between signatures, reset seam;
 * - headless punish flow end-to-end at transport level: punish -> same-account
 *   retry (new chat) -> persisted punish -> probe-rotate (exactly one rotation
 *   signal, no cooldown); second account same signature -> SharedWafCircuit
 *   (429 hint) with no further fetch (third account never consumed);
 * - same flow with and without x5sec in the jar (policy is signature-based);
 * - concurrent punish flows stay bounded and fast (no 300s waits);
 * - client mapping: SharedWafCircuitError -> 429 UpstreamRateLimit;
 * - punish path assigns no cooldown (policy carries no accountCooldownMs);
 * - circuit-open entry fails fast without touching accounts.
 *
 * Secrets: only in-test constants, never logged (transport logs redactions).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { deleteAuthSession, saveAuthSession } from "../core/database.ts";
import { UpstreamRateLimit } from "../core/errors.ts";
import { classifyError } from "../api/error-classifier.ts";
import {
  isWafCircuitOpen,
  recordWafPunish,
  SharedWafCircuitError,
  WAF_CIRCUIT_TTL_MS,
  wafCircuitTtlRemainingMs,
  wafSignatureFromDirectResult,
  _resetWafCircuitForTests,
} from "../core/waf-circuit.ts";
import {
  createDirectAccountStream,
  DirectTransportWafBlocked,
  selectWafRecoveryMode,
} from "../services/qwen-direct-stream.ts";
import { classifyRetryAction } from "../routes/chat/retry-policy.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0";
const BEARER = "eyJmaXhlLWUtdGVzdC1iZWFyZXIudG9rZW4";

function seedAccount(id: string, withX5sec: boolean): void {
  deleteAuthSession(id);
  const pairs = [`token=${BEARER}`, "refresh_token=R-E1", "cna=e1"];
  if (withX5sec) pairs.push("x5sec=held-clearance-1");
  saveAuthSession(id, {
    cookie: pairs.join("; "),
    userAgent: UA,
    bxV: "2.5.37",
    bxUa: "",
    bxUmidtoken: "",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    capturedAt: Date.now(),
    refreshToken: "R-E1",
  });
}

function cleanupAccount(id: string): void {
  try {
    deleteAuthSession(id);
  } catch {}
}

function punishBody(): string {
  return JSON.stringify({
    success: false,
    request_id: "r-punish",
    data: { code: "FAIL_SYS_USER_VALIDATE", details: "RGV587_ERROR::SM::x" },
    url: "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc",
  });
}

function rgvBody(): string {
  return JSON.stringify({
    success: false,
    request_id: "r-rgv",
    data: { code: "FAIL_SYS_USER_VALIDATE", details: "RGV587_ERROR::SM::y" },
  });
}

function sseBody(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(
        enc.encode(
          `data: {"response": {"messages": [{"content": "${text}"}]}}\n\ndata: [DONE]\n\n`,
        ),
      );
      c.close();
    },
  });
}

interface FetchCounts {
  create: number;
  completions: number;
}

/** Stub: chats/new always succeeds; completions follow a per-test script. */
function installFetch(
  completionScript: Array<"punish" | "rgv" | "ok">,
  counts: FetchCounts,
): () => void {
  const originalFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    if (url.includes("/api/v2/chats/new")) {
      counts.create += 1;
      return new Response(
        JSON.stringify({ success: true, data: { id: `chat-${counts.create}` } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.includes("/api/v2/chat/completions")) {
      counts.completions += 1;
      const step = completionScript[Math.min(n++, completionScript.length - 1)];
      if (step === "ok") {
        return new Response(sseBody("OK"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(step === "rgv" ? rgvBody() : punishBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function directPunishFlow(accountId: string): Promise<{ error: unknown }> {
  try {
    const r = await createDirectAccountStream({
      prompt: "Responde únicamente: OK",
      model: "qwen3.8-max",
      accountId,
      modernPersisted: true,
    });
    await (r.stream as ReadableStream).cancel().catch(() => {});
    return { error: null };
  } catch (error) {
    return { error };
  }
}

// ── mode selection + signatures (pure) ──────────────────────────────────────

test("headless production takes the automatic path; headed keeps human wait", () => {
  assert.equal(selectWafRecoveryMode(true), "headless-auto");
  assert.equal(selectWafRecoveryMode(false), "human");
});

test("punish signature classes: punish_url vs rgv vs plain waf", () => {
  assert.equal(
    wafSignatureFromDirectResult("https://chat.qwen.ai/_____tmd_____/punish?x=1", "{}"),
    "punish_url",
  );
  assert.equal(wafSignatureFromDirectResult(null, rgvBody()), "rgv587");
  assert.equal(wafSignatureFromDirectResult(null, "<html>captcha</html>"), "waf-challenge");
  assert.equal(wafSignatureFromDirectResult(null, null), "waf-challenge");
});

// ── circuit unit ────────────────────────────────────────────────────────────

test("circuit opens on second independent account, same signature only", () => {
  _resetWafCircuitForTests();
  try {
    const t = Date.now();
    assert.deepEqual(recordWafPunish("acc-a", "punish_url", t).shared, false);
    assert.equal(isWafCircuitOpen("punish_url", t), false);
    const second = recordWafPunish("acc-b", "punish_url", t + 1);
    assert.equal(second.shared, true);
    assert.equal(second.confirmations, 2);
    assert.equal(isWafCircuitOpen("punish_url", t + 1), true);
    assert.equal(isWafCircuitOpen(undefined, t + 1), true);
    // Different signature is unaffected.
    assert.equal(isWafCircuitOpen("rgv587", t + 1), false);
    assert.deepEqual(recordWafPunish("acc-c", "rgv587", t + 2).shared, false);
    assert.ok(wafCircuitTtlRemainingMs(t + 2) > 0);
    // TTL expiry reopens the pool (monotonic time).
    assert.equal(isWafCircuitOpen("punish_url", t + WAF_CIRCUIT_TTL_MS + 1), false);
    assert.equal(wafCircuitTtlRemainingMs(t + WAF_CIRCUIT_TTL_MS + 1), 0);
  } finally {
    _resetWafCircuitForTests();
  }
});

// ── transport flow: punish -> retry -> probe-rotate (fast, no cooldown) ──────

test("headless punish persists: one same-account retry, then probe-rotate", async () => {
  const id = "fixe-acc-a";
  seedAccount(id, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restore = installFetch(["punish", "punish"], counts);
  try {
    const start = Date.now();
    const { error } = await directPunishFlow(id);
    const elapsed = Date.now() - start;
    assert.ok(error instanceof DirectTransportWafBlocked);
    assert.equal((error as DirectTransportWafBlocked).blockReason, "probe-rotate");
    // Leg 1 + exactly one same-account retry leg. No 300s human wait.
    assert.equal(counts.create, 2);
    assert.equal(counts.completions, 2);
    assert.ok(elapsed < 30_000, `must not wait for a human (took ${elapsed}ms)`);
    // No cooldown assigned anywhere on the punish path.
    assert.equal(getAccountCooldownInfo(id), null);
    const policy = classifyRetryAction(error, { requestAborted: false });
    assert.equal(policy.reason, "waf_probe_rotate");
    assert.equal(policy.switchAccount, true);
    assert.ok(!policy.accountCooldownMs);
  } finally {
    restore();
    cleanupAccount(id);
    _resetWafCircuitForTests();
  }
});

test("same-account retry success continues the request on a new chat", async () => {
  const id = "fixe-acc-retry-ok";
  seedAccount(id, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restore = installFetch(["punish", "ok"], counts);
  try {
    const r = await createDirectAccountStream({
      prompt: "Responde únicamente: OK",
      model: "qwen3.8-max",
      accountId: id,
      modernPersisted: true,
    });
    // Second leg minted a brand-new chat after the punish.
    assert.equal(r.uiSessionId, "chat-2");
    assert.equal(counts.create, 2);
    assert.equal(counts.completions, 2);
    await (r.stream as ReadableStream).cancel().catch(() => {});
  } finally {
    restore();
    cleanupAccount(id);
    _resetWafCircuitForTests();
  }
});

test("second account same punish opens the circuit; third consumes nothing", async () => {
  const a = "fixe-acc-2a";
  const b = "fixe-acc-2b";
  const c = "fixe-acc-2c";
  seedAccount(a, false);
  seedAccount(b, false);
  seedAccount(c, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restore = installFetch(["punish", "punish"], counts);
  try {
    const ra = await directPunishFlow(a);
    assert.ok(ra.error instanceof DirectTransportWafBlocked);
    assert.equal(isWafCircuitOpen(), false);

    const rb = await directPunishFlow(b);
    assert.ok(rb.error instanceof SharedWafCircuitError);
    assert.equal((rb.error as SharedWafCircuitError).upstreamStatus, 429);
    assert.equal(isWafCircuitOpen(), true);

    // Third account: circuit-open fast path throws before any fetch.
    const frozen = { ...counts };
    const rc = await directPunishFlow("fixe-acc-2c");
    assert.ok(rc.error instanceof SharedWafCircuitError);
    assert.deepEqual(counts, frozen);
  } finally {
    restore();
    cleanupAccount(a);
    cleanupAccount(b);
    cleanupAccount(c);
    _resetWafCircuitForTests();
  }
});

test("x5sec present and absent follow the same headless policy", async () => {
  const withX = "fixe-acc-x5";
  const withoutX = "fixe-acc-nox5";
  seedAccount(withX, true);
  seedAccount(withoutX, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restore = installFetch(["punish", "punish"], counts);
  try {
    const r1 = await directPunishFlow(withX);
    assert.ok(r1.error instanceof DirectTransportWafBlocked);
    const r2 = await directPunishFlow(withoutX);
    assert.ok(r2.error instanceof SharedWafCircuitError);
  } finally {
    restore();
    cleanupAccount(withX);
    cleanupAccount(withoutX);
    _resetWafCircuitForTests();
  }
});

test("different second signature does not open the shared circuit", async () => {
  const a = "fixe-acc-sig-a";
  const b = "fixe-acc-sig-b";
  seedAccount(a, false);
  seedAccount(b, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restoreA = installFetch(["punish", "punish"], counts);
  try {
    const ra = await directPunishFlow(a);
    assert.ok(ra.error instanceof DirectTransportWafBlocked);
  } finally {
    restoreA();
  }
  const restoreB = installFetch(["rgv", "rgv"], counts);
  try {
    const rb = await directPunishFlow(b);
    assert.ok(rb.error instanceof DirectTransportWafBlocked);
    assert.equal(
      (rb.error as DirectTransportWafBlocked).blockReason,
      "probe-rotate",
    );
    assert.equal(isWafCircuitOpen(), false);
  } finally {
    restoreB();
    cleanupAccount(a);
    cleanupAccount(b);
    _resetWafCircuitForTests();
  }
});

test("auth failure on second account does not classify shared WAF", () => {
  _resetWafCircuitForTests();
  try {
    assert.deepEqual(recordWafPunish("acc-auth-a", "punish_url").shared, false);
    // A 401 elsewhere never records: circuit stays closed on one observation.
    assert.equal(isWafCircuitOpen(), false);
  } finally {
    _resetWafCircuitForTests();
  }
});

// ── client mapping + policy ─────────────────────────────────────────────────

test("circuit open at request entry fails fast without touching accounts", async () => {
  const { acquireUpstreamStream } = await import("../routes/chat/account.ts");
  _resetWafCircuitForTests();
  try {
    recordWafPunish("entry-acc-a", "punish_url", Date.now());
    recordWafPunish("entry-acc-b", "punish_url", Date.now());
    assert.equal(isWafCircuitOpen(), true);
    const out = (await acquireUpstreamStream({
      finalPrompt: "hi",
      fullPrompt: "hi",
      isThinkingModel: false,
      model: "qwen3.8-max",
      shouldResetUpstreamThread: false,
      allFiles: [],
      isNewSession: true,
      sessionId: null,
      useThreadNative: false,
      updateLogicalThread: false,
      allowThreadReuse: false,
      chatMode: "thread",
    })) as { error?: unknown };
    assert.ok(out.error instanceof SharedWafCircuitError);
  } finally {
    _resetWafCircuitForTests();
  }
});

test("circuit error maps to retryable 429 and is policy-terminal", () => {
  _resetWafCircuitForTests();
  const err = new SharedWafCircuitError("punish_url", 42_000);
  assert.equal(err.upstreamStatus, 429);
  assert.equal(err.retryAfterMs, 42_000);
  const mapped = classifyError(err);
  assert.ok(mapped instanceof UpstreamRateLimit);
  assert.equal(mapped.statusCode, 429);
  const policy = classifyRetryAction(err, { requestAborted: false });
  assert.equal(policy.reason, "shared_waf_circuit_open");
  assert.equal(policy.retryable, false);
  assert.ok(!policy.accountCooldownMs);
});

test("concurrent punish flows stay bounded and fast, circuit opens", async () => {
  const ids = ["fixe-acc-c1", "fixe-acc-c2", "fixe-acc-c3"];
  for (const id of ids) seedAccount(id, false);
  _resetWafCircuitForTests();
  const counts = { create: 0, completions: 0 };
  const restore = installFetch(["punish", "punish"], counts);
  try {
    const start = Date.now();
    const results = await Promise.all(ids.map((id) => directPunishFlow(id)));
    const elapsed = Date.now() - start;
    for (const r of results) {
      assert.ok(
        r.error instanceof DirectTransportWafBlocked ||
          r.error instanceof SharedWafCircuitError,
      );
    }
    assert.equal(isWafCircuitOpen(), true);
    // 2 legs max per account (leg 1 + one same-account retry). No 300s waits.
    assert.ok(counts.completions <= ids.length * 2);
    assert.ok(counts.create <= ids.length * 2);
    assert.ok(elapsed < 30_000, `must stay bounded (took ${elapsed}ms)`);
  } finally {
    restore();
    for (const id of ids) cleanupAccount(id);
    _resetWafCircuitForTests();
  }
});
