/**
 * Auth retry classification and rejected-account persistence.
 *
 * A confirmed credential/session failure must switch accounts, mark the
 * account rejected and never retry the same account. Infrastructure failures
 * (page crash, navigation, init timeout) must cool down but NOT reject.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  addAccount,
  getAccountAuthState,
  removeAccount,
  setAccountAuthState,
} from "../core/accounts.ts";
import {
  getNextAvailableAccount,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import {
  classifyRetryAction,
  isConfirmedAuthError,
} from "../routes/chat/retry-policy.ts";
import { validateAccountSessionForInit, registerPlaywrightAccountForTests, unregisterPlaywrightAccountForTests } from "../services/playwright.ts";
import { PersonalizationSyncError, QwenUpstreamError } from "../services/qwen.ts";
import { prepareQwenRuntime } from "../api/server.ts";
import { saveAuthSession, deleteAuthSession } from "../core/database.ts";
import { ensureAccountSession } from "../services/qwen-token-refresh.ts";

const created: string[] = [];
function mk(tag: string) {
  const a = addAccount(
    `authretry-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.org`,
    "x",
  );
  created.push(a.id);
  return a;
}
after(() => {
  for (const id of created) {
    try {
      removeAccount(id);
    } catch {}
  }
});

test("session expired + re-auth failed is a confirmed auth failure", () => {
  const err = new Error(
    "Session expired for user@example.org and re-authentication failed",
  );
  assert.equal(isConfirmedAuthError(err), true);
  const policy = classifyRetryAction(err, { requestAborted: false });
  assert.equal(policy.reason, "account_initialization_failed");
  assert.equal(policy.switchAccount, true);
  assert.equal(policy.accountCooldownReason, "AuthInitFailed");
});

test("AuthPermanentFailure with detail is a confirmed auth failure", () => {
  const err = new Error("AuthPermanentFailure: Senha incorreta (bad password)");
  assert.equal(isConfirmedAuthError(err), true);
  const policy = classifyRetryAction(err, { requestAborted: false });
  assert.equal(policy.accountCooldownReason, "AuthInitFailed");
});

test("page crash / navigation is not an auth failure", () => {
  const err = new Error("page.goto: Page crashed");
  assert.equal(isConfirmedAuthError(err), false);
  const policy = classifyRetryAction(err, { requestAborted: false });
  assert.notEqual(policy.accountCooldownReason, "AuthInitFailed");
});

test("infrastructure init failure cools down but does not reject", () => {
  const err = new Error("Playwright page unavailable for account: abc");
  assert.equal(isConfirmedAuthError(err), false);
  const policy = classifyRetryAction(err, { requestAborted: false });
  assert.equal(policy.reason, "account_initialization_failed");
  assert.equal(policy.accountCooldownReason, "InitFailed");
});

test("unconfirmed create-chat failures preserve persisted authentication", () => {
  for (const [code, message, status] of [
    ["CreateChatInvalidResponse", "Qwen create chat returned unexpected payload: ", 502],
    ["CreateChatInvalidResponse", 'Qwen create chat returned unexpected payload: {"success":true,"data":{}}', 502],
    ["CreateChatFailed", "Qwen create chat failed: 503 Service Unavailable", 502],
  ] as const) {
    const a = mk(`create-${code}`);
    setAccountAuthState(a.id, "valid");
    const error = new QwenUpstreamError(message, code, status);
    const policy = classifyRetryAction(error);
    assert.equal(isConfirmedAuthError(error), false);
    assert.equal(policy.accountCooldownReason, "InitFailed");
    assert.equal(policy.switchAccount, true);
    assert.equal(policy.forceNewChat, true);
    assert.equal(policy.retryWithFullPrompt, true);
    markAccountRateLimited(a.id, 1000, policy.accountCooldownReason);
    assert.equal(getAccountAuthState(a.id), "valid");
  }
});

test("create-chat auth evidence still persists rejection", () => {
  for (const [code, message, status] of [
    ["Unauthorized", "Qwen create chat unauthorized", 401],
    ["CreateChatFailed", "Qwen create chat failed: 401 Unknown", 401],
    ["CreateChatInvalidResponse", 'Qwen create chat returned unexpected payload: {"success":false,"data":{"code":"Unauthorized"}}', 502],
  ] as const) {
    const a = mk(`create-auth-${code}`);
    setAccountAuthState(a.id, "valid");
    const policy = classifyRetryAction(new QwenUpstreamError(message, code, status));
    assert.equal(policy.accountCooldownReason, "AuthInitFailed");
    markAccountRateLimited(a.id, 1000, policy.accountCooldownReason);
    assert.equal(getAccountAuthState(a.id), "rejected");
  }
});

test("prefixed AuthPermanentFailure reason persists auth_state=rejected", () => {
  const a = mk("prefix");
  setAccountAuthState(a.id, "valid");
  markAccountRateLimited(a.id, 300_000, "AuthPermanentFailure: Senha incorreta");
  assert.equal(getAccountAuthState(a.id), "rejected");
});

test("PersonalizationFailed / infra cooldown does not reject", () => {
  const a = mk("infra");
  setAccountAuthState(a.id, "valid");
  markAccountRateLimited(a.id, 300_000, "PersonalizationFailed");
  assert.equal(getAccountAuthState(a.id), "valid");
});

test("no eligible account returns null (fail fast, no same-account retry)", () => {
  const a = mk("only-rejected");
  setAccountAuthState(a.id, "rejected");
  const others = new Set(created.filter((x) => x !== a.id));
  assert.equal(getNextAvailableAccount(others), null);
});

function probePage(reasons: string[]) {
  let calls = 0;
  return {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => ({ reason: reasons[Math.min(calls++, reasons.length - 1)], obs: [], res: [] }),
  };
}

test("inconclusive init probes preserve auth even inside personalization errors", async () => {
  for (const reason of ["timeout", "context-destroyed", "evaluate-error", "page-closed", "auth-url", "settings-status"]) {
    const a = mk(`inconclusive-${reason}`);
    setAccountAuthState(a.id, "valid");
    let recoveryCalls = 0;
    const error = await validateAccountSessionForInit(probePage([reason]) as never, a.id, async () => {
      recoveryCalls++;
      return false;
    }).then(() => assert.fail("must not accept an unverified session"), (e: Error) => e);
    assert.equal(recoveryCalls, 0, reason);
    for (const e of [error, new PersonalizationSyncError(error.message)]) {
      const policy = classifyRetryAction(e);
      assert.equal(isConfirmedAuthError(e), false, reason);
      assert.notEqual(policy.accountCooldownReason, "AuthInitFailed", reason);
      markAccountRateLimited(a.id, 1000, policy.accountCooldownReason);
      assert.equal(getAccountAuthState(a.id), "valid", reason);
    }
  }
});

test("failed/deferred recovery plus an inconclusive final probe is not rejection", async () => {
  const a = mk("deferred-recovery");
  setAccountAuthState(a.id, "valid");
  let recoveryCalls = 0;
  const error = await validateAccountSessionForInit(probePage(["settings-401", "timeout"]) as never, a.id, async () => {
    recoveryCalls++;
    return false;
  }).then(() => assert.fail("must not accept an unverified session"), (e: Error) => e);
  assert.equal(recoveryCalls, 1);
  const policy = classifyRetryAction(error);
  assert.equal(policy.accountCooldownReason, "InitFailed");
  markAccountRateLimited(a.id, 1000, policy.accountCooldownReason);
  assert.equal(getAccountAuthState(a.id), "valid");
});

test("only the final authoritative settings rejection rejects init", async () => {
  for (const reason of ["settings-401", "settings-403", "settings-revoked"]) {
    const a = mk(`rejected-${reason}`);
    setAccountAuthState(a.id, "valid");
    const error = await validateAccountSessionForInit(probePage([reason]) as never, a.id, async () => false)
      .then(() => assert.fail("must reject"), (e: Error) => e);
    for (const e of [error, new PersonalizationSyncError(error.message)]) {
      const policy = classifyRetryAction(e);
      assert.equal(policy.accountCooldownReason, "AuthInitFailed", reason);
      markAccountRateLimited(a.id, 1000, policy.accountCooldownReason);
      assert.equal(getAccountAuthState(a.id), "rejected", reason);
    }
  }
});

test("init accepts a confirmed settings session without relying on the recovery boolean", async () => {
  let calls = 0;
  await validateAccountSessionForInit(probePage(["settings-401", "ok"]) as never, "confirmed", async () => {
    calls++;
    return false;
  });
  assert.equal(calls, 1);
  await validateAccountSessionForInit(probePage(["ok"]) as never, "already-valid", async () => {
    assert.fail("valid session needs no recovery");
  });
});

test("startup runtime failure rejects credentials only with confirmed auth evidence", async () => {
  for (const [error, expected] of [
    [new Error("page.goto: Page crashed"), "valid"],
    [Object.assign(new Error("Playwright session validation inconclusive"), { code: "session_validation_inconclusive" }), "valid"],
    [Object.assign(new Error("Unauthorized session validation"), { code: "unauthorized" }), "rejected"],
  ] as const) {
    const a = mk("runtime");
    setAccountAuthState(a.id, "valid");
    const ok = await prepareQwenRuntime({
      accountId: a.id,
      successMessage: "ready",
      failureMessage: "test runtime failure",
      initAuth: async () => { throw error; },
      disableNativeTools: async () => { assert.fail("init did not finish"); },
      warmQwenChatPool: async () => { assert.fail("init did not finish"); },
    });
    assert.equal(ok, false);
    assert.equal(getAccountAuthState(a.id), expected);
  }
});

test("default recovery verifier does not invent HTTP 200 for unavailable settings", async () => {
  for (const reason of ["settings-unavailable", "settings-inconclusive"]) {
    const a = mk(reason);
    setAccountAuthState(a.id, "valid");
    saveAuthSession(a.id, {
      cookie: "token=synthetic-session",
      userAgent: "test-UA",
      bxV: "2.5.37",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      capturedAt: Date.now(),
    });
    registerPlaywrightAccountForTests(a.id, probePage([reason]) as never, Date.now());
    try {
      const result = await ensureAccountSession(a.id);
      assert.equal(result.sessionVerified, "inconclusive");
      assert.equal(getAccountAuthState(a.id), "valid");
    } finally {
      unregisterPlaywrightAccountForTests(a.id);
      deleteAuthSession(a.id);
    }
  }
});
