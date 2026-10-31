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
