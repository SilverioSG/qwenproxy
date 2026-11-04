/**
 * READY treatment on the real 401 path (not loginToQwen).
 *
 * attemptRelogin is the real 401 caller. A conclusive rejection must remove
 * READY; inconclusive/deferred/page-required preserve the previous state, and
 * a never-verified account must not become READY.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deleteAuthSession, saveAuthSession } from "../core/database.ts";
import {
  isAccountHeadersReady,
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import {
  resetAuthRecoveryForTests,
  setAuthRecoveryDeps,
  type AuthRecoveryVerification,
} from "../services/auth-recovery.ts";
import { _attemptReloginForTests } from "../routes/chat/account.ts";

function seed(id: string): void {
  deleteAuthSession(id);
  saveAuthSession(id, {
    cookie: "token=ready-audit-jwt; refresh_token=ready-audit-refresh",
    userAgent: "Mozilla/5.0 ReadyAudit",
    bxV: "2.5.37",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "ready-audit-refresh",
    capturedAt: Date.now(),
  });
}

function verifyWith(result: AuthRecoveryVerification): void {
  resetAuthRecoveryForTests();
  setAuthRecoveryDeps({
    verifySession: async () => result,
    hasActiveStream: () => false,
    isBusy: () => false,
    isOnCooldown: () => false,
    hasActiveManualVerification: async () => false,
  });
}

test.afterEach(() => resetAuthRecoveryForTests());

test("401 rejected unmarks a previously READY account", async () => {
  const id = "ready-audit-rejected";
  seed(id);
  markAccountHeadersReady(id);
  verifyWith({ state: "rejected", reason: "settings-401" });
  try {
    const ok = await _attemptReloginForTests(id, "ready@example.invalid", "owner");
    assert.equal(ok, false);
    assert.equal(
      isAccountHeadersReady(id),
      false,
      "conclusive rejection must not stay READY",
    );
  } finally {
    unmarkAccountHeadersReady(id);
    deleteAuthSession(id);
  }
});

test("401 inconclusive preserves a previously READY account", async () => {
  const id = "ready-audit-inconclusive";
  seed(id);
  markAccountHeadersReady(id);
  verifyWith({ state: "inconclusive", reason: "timeout" });
  try {
    const ok = await _attemptReloginForTests(id, "ready@example.invalid", "owner");
    assert.equal(ok, false);
    assert.equal(isAccountHeadersReady(id), true);
  } finally {
    unmarkAccountHeadersReady(id);
    deleteAuthSession(id);
  }
});

test("401 inconclusive does not create READY for a never-verified account", async () => {
  const id = "ready-audit-never";
  seed(id);
  unmarkAccountHeadersReady(id);
  verifyWith({ state: "inconclusive", reason: "evaluate-error" });
  try {
    const ok = await _attemptReloginForTests(id, "ready@example.invalid", "owner");
    assert.equal(ok, false);
    assert.equal(isAccountHeadersReady(id), false);
  } finally {
    unmarkAccountHeadersReady(id);
    deleteAuthSession(id);
  }
});
