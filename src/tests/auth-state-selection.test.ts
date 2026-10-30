/**
 * Persistent auth state vs account selection.
 *
 * A confirmed 401 (AuthInitFailed) marks the account `rejected`; the picker
 * must skip it even after its short cooldown expires, and a later validated
 * login/refresh/create (`valid`) must re-admit it. This is NOT a cooldown.
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
  clearAccountCooldown,
  getNextAvailableAccount,
  markAccountRateLimited,
} from "../core/account-manager.ts";

const created: string[] = [];

function mk(tag: string) {
  const account = addAccount(
    `authstate-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.org`,
    "x",
  );
  created.push(account.id);
  return account;
}

/** Tried set containing every account except the target: the picker can only
 *  return the target (or null when it is not selectable). */
function only(id: string): Set<string> {
  return new Set(created.filter((x) => x !== id));
}

after(() => {
  for (const id of created) {
    try {
      removeAccount(id);
    } catch {}
  }
});

test("rejected account is skipped even with no cooldown", () => {
  const a = mk("rejected");
  setAccountAuthState(a.id, "rejected");
  clearAccountCooldown(a.id);
  assert.equal(getAccountAuthState(a.id), "rejected");
  assert.equal(getNextAvailableAccount(only(a.id)), null);
});

test("validated account is selectable again", () => {
  const a = mk("recover");
  setAccountAuthState(a.id, "rejected");
  assert.equal(getNextAvailableAccount(only(a.id)), null);
  setAccountAuthState(a.id, "valid");
  assert.equal(getNextAvailableAccount(only(a.id))?.id, a.id);
});

test("cooldown expiry does not resurrect a rejected account", () => {
  const a = mk("cooldown");
  markAccountRateLimited(a.id, 1, "AuthInitFailed");
  assert.equal(getAccountAuthState(a.id), "rejected");
  clearAccountCooldown(a.id);
  assert.equal(getNextAvailableAccount(only(a.id)), null);
});

test("rate-limit cooldowns do not mark auth rejected", () => {
  const a = mk("ratelimit");
  setAccountAuthState(a.id, "valid");
  markAccountRateLimited(a.id, 300_000, "RateLimited");
  assert.equal(getAccountAuthState(a.id), "valid");
  clearAccountCooldown(a.id);
  assert.equal(getNextAvailableAccount(only(a.id))?.id, a.id);
});

test("an auth failure marks rejected and a valid peer stays selectable", () => {
  const bad = mk("bad");
  const good = mk("good");
  setAccountAuthState(good.id, "valid");
  markAccountRateLimited(bad.id, 300_000, "AuthInitFailed");
  assert.equal(getAccountAuthState(bad.id), "rejected");
  assert.equal(getNextAvailableAccount(only(good.id))?.id, good.id);
});
