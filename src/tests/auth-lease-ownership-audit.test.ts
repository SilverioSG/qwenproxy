/**
 * Authentication-recovery lease ownership.
 *
 * sessionLabel stays the concurrency/session label. Recovery ownership uses
 * the unique accountLease.leaseId, so two requests that share an email or a
 * sessionId can still distinguish each other.
 *
 * No real DB, browser or Qwen: verifier and account gates are injected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../core/config.ts";
import { deleteAuthSession, saveAuthSession } from "../core/database.ts";
import {
  abortLeaseByLabel,
  hasOtherActiveAccountLeaseByLeaseId,
  tryAcquireAccountLease,
} from "../core/account-concurrency.ts";
import {
  recoverAccountSession,
  resetAuthRecoveryForTests,
  setAuthRecoveryDeps,
} from "../services/auth-recovery.ts";
import { _attemptReloginForTests } from "../routes/chat/account.ts";

let verifyCalls = 0;

test.beforeEach(() => {
  verifyCalls = 0;
  resetAuthRecoveryForTests();
  setAuthRecoveryDeps({
    verifySession: async () => {
      verifyCalls += 1;
      return { state: "valid", reason: "settings-ok" };
    },
  });
});

test.afterEach(() => resetAuthRecoveryForTests());

function withTwoSlots(): () => void {
  const previous = config.concurrency.maxStreamsPerAccount;
  config.concurrency.maxStreamsPerAccount = 2;
  return () => {
    config.concurrency.maxStreamsPerAccount = previous;
  };
}

test("stateless: same account/email, two distinct leases -> other lease defers", async () => {
  const restore = withTwoSlots();
  const id = "lease-stateless-email";
  const emailLabel = "same@example.com";
  const own = tryAcquireAccountLease(id, emailLabel);
  const other = tryAcquireAccountLease(id, emailLabel);
  try {
    assert.ok(own);
    assert.ok(other);
    assert.notEqual(own!.leaseId, other!.leaseId);
    assert.equal(
      hasOtherActiveAccountLeaseByLeaseId(id, own!.leaseId),
      true,
    );
    const r = await recoverAccountSession(id, "401", {
      ownerLeaseId: own!.leaseId,
    });
    assert.equal(r.outcome, "deferred");
    assert.equal(verifyCalls, 0);
  } finally {
    own?.release();
    other?.release();
    restore();
  }
});

test("thread: same sessionId, two distinct leases -> other lease defers", async () => {
  const restore = withTwoSlots();
  const id = "lease-thread-session";
  const sessionLabel = "sess_0123456789abcdef";
  const own = tryAcquireAccountLease(id, sessionLabel);
  const other = tryAcquireAccountLease(id, sessionLabel);
  try {
    assert.ok(own);
    assert.ok(other);
    assert.equal(
      hasOtherActiveAccountLeaseByLeaseId(id, own!.leaseId),
      true,
    );
    const r = await recoverAccountSession(id, "401", {
      ownerLeaseId: own!.leaseId,
    });
    assert.equal(r.outcome, "deferred");
    assert.equal(verifyCalls, 0);
  } finally {
    own?.release();
    other?.release();
    restore();
  }
});

test("own lease alone allows verification", async () => {
  const id = "lease-own-only";
  const own = tryAcquireAccountLease(id, "owner@example.com");
  try {
    assert.ok(own);
    assert.equal(
      hasOtherActiveAccountLeaseByLeaseId(id, own!.leaseId),
      false,
    );
    const r = await recoverAccountSession(id, "401", {
      ownerLeaseId: own!.leaseId,
    });
    assert.equal(r.outcome, "verified");
    assert.equal(verifyCalls, 1);
  } finally {
    own?.release();
  }
});

test("another request's lease defers, even with a different ownerLeaseId", async () => {
  const id = "lease-other-only";
  const other = tryAcquireAccountLease(id, "other@example.com");
  try {
    assert.ok(other);
    const r = await recoverAccountSession(id, "401", {
      ownerLeaseId: "lease_from_a_different_request",
    });
    assert.equal(r.outcome, "deferred");
    assert.equal(verifyCalls, 0);
  } finally {
    other?.release();
  }
});

test("released lease stops blocking", async () => {
  const id = "lease-released";
  const lease = tryAcquireAccountLease(id, "released@example.com");
  assert.ok(lease);
  const leaseId = lease!.leaseId;
  lease!.release();
  const r = await recoverAccountSession(id, "401", {
    ownerLeaseId: leaseId,
  });
  assert.equal(r.outcome, "verified");
  assert.equal(verifyCalls, 1);
});

test("aborted lease stops blocking", async () => {
  const id = "lease-aborted";
  const label = "aborted@example.com";
  const lease = tryAcquireAccountLease(id, label);
  assert.ok(lease);
  assert.equal(abortLeaseByLabel(id, label), true);
  const r = await recoverAccountSession(id, "401", {
    ownerLeaseId: lease!.leaseId,
  });
  assert.equal(r.outcome, "verified");
  assert.equal(verifyCalls, 1);
});

test("stale lease is swept and stops blocking", async () => {
  const id = "lease-stale";
  const previousMax = config.concurrency.leaseMaxDurationMs;
  config.concurrency.leaseMaxDurationMs = 1;
  const lease = tryAcquireAccountLease(id, "stale@example.com");
  assert.ok(lease);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      hasOtherActiveAccountLeaseByLeaseId(
        id,
        "lease_from_a_different_request",
      ),
      false,
    );
    const r = await recoverAccountSession(id, "401", {
      ownerLeaseId: "lease_from_a_different_request",
    });
    assert.equal(r.outcome, "verified");
    assert.equal(verifyCalls, 1);
  } finally {
    lease!.release();
    config.concurrency.leaseMaxDurationMs = previousMax;
  }
});

function seedAuth(id: string): void {
  deleteAuthSession(id);
  saveAuthSession(id, {
    cookie: "token=lease-audit-jwt; refresh_token=lease-audit-refresh",
    userAgent: "Mozilla/5.0 LeaseAudit",
    bxV: "2.5.37",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "lease-audit-refresh",
    capturedAt: Date.now(),
  });
}

test("real attemptRelogin: own leaseId proceeds to verification", async () => {
  const id = "lease-attempt-own";
  seedAuth(id);
  const lease = tryAcquireAccountLease(id, "same@example.com");
  assert.ok(lease);
  try {
    const ok = await _attemptReloginForTests(
      id,
      "same@example.com",
      lease!.leaseId,
    );
    assert.equal(ok, true);
    assert.equal(verifyCalls, 1);
  } finally {
    lease!.release();
    deleteAuthSession(id);
  }
});

test("real attemptRelogin: a same-email lease from another request defers", async () => {
  const restore = withTwoSlots();
  const id = "lease-attempt-other";
  seedAuth(id);
  const own = tryAcquireAccountLease(id, "same@example.com");
  const other = tryAcquireAccountLease(id, "same@example.com");
  assert.ok(own);
  assert.ok(other);
  try {
    const ok = await _attemptReloginForTests(
      id,
      "same@example.com",
      own!.leaseId,
    );
    assert.equal(ok, false);
    assert.equal(verifyCalls, 0);
  } finally {
    own!.release();
    other!.release();
    deleteAuthSession(id);
    restore();
  }
});
