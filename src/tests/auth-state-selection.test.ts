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
  invalidateAccountsCache,
  loadAccounts,
  removeAccount,
  setAccountAuthState,
} from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import {
  clearAccountCooldown,
  getNextAccount,
  getNextAvailableAccount,
  markAccountHeadersReady,
  markAccountRateLimited,
} from "../core/account-manager.ts";
import { ServiceUnavailable } from "../core/errors.ts";
import { resolveInitialAccount } from "../routes/chat/account.ts";

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

/** Run fn with every persisted account rejected, restoring exact state after. */
function withAllRejected<T>(fn: () => T): T {
  const all = loadAccounts();
  const before = all.map((a) => ({ id: a.id, state: a.auth_state ?? null }));
  const db = getDatabase();
  try {
    for (const a of all) setAccountAuthState(a.id, "rejected");
    return fn();
  } finally {
    for (const b of before) {
      if (b.state === null) {
        db.prepare("UPDATE accounts SET auth_state = NULL WHERE id = ?").run(b.id);
      } else {
        setAccountAuthState(b.id, b.state);
      }
    }
    invalidateAccountsCache();
  }
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

test("sticky preferred account cannot be a rejected account", () => {
  const preferred = mk("sticky-rejected");
  const fallback = mk("sticky-fallback");
  setAccountAuthState(preferred.id, "rejected");
  setAccountAuthState(fallback.id, "valid");
  clearAccountCooldown(preferred.id);
  const resolved = resolveInitialAccount(preferred.id);
  assert.notEqual(resolved.account.id, preferred.id);
  assert.notEqual(getAccountAuthState(resolved.account.id), "rejected");
});

test("sticky affinity is preserved for a valid preferred account", () => {
  const preferred = mk("sticky-valid");
  const other = mk("sticky-other");
  setAccountAuthState(preferred.id, "valid");
  setAccountAuthState(other.id, "valid");
  const resolved = resolveInitialAccount(preferred.id);
  assert.equal(resolved.account.id, preferred.id);
});

test("getNextAccount skips rejected and returns the valid peer", () => {
  const bad = mk("next-bad");
  const good = mk("next-good");
  withAllRejected(() => {
    setAccountAuthState(good.id, "valid");
    markAccountHeadersReady(good.id);
    assert.equal(getNextAccount()?.id, good.id);
    setAccountAuthState(bad.id, "rejected");
    setAccountAuthState(good.id, "rejected");
    assert.equal(getNextAccount(), null);
  });
});

test("all rejected -> resolveInitialAccount fails controlled", () => {
  withAllRejected(() => {
    assert.throws(
      () => resolveInitialAccount(),
      (e: unknown) => e instanceof ServiceUnavailable,
    );
  });
});

test("rejected ready does not activate anyReady for a valid cold peer", () => {
  const bad = mk("gate-bad");
  const good = mk("gate-good");
  withAllRejected(() => {
    setAccountAuthState(bad.id, "rejected");
    markAccountHeadersReady(bad.id);
    setAccountAuthState(good.id, "valid");
    // good stays cold (no headers-ready mark): the rejected peer must not
    // activate the anyReady gate that would exclude it.
    assert.equal(getNextAccount()?.id, good.id);
  });
});
