/**
 * Integration gate simulations (Phase 1/2A/2B).
 *
 * Isolated tests only: no browser, no real DB/profiles, no external login.
 * They model the real coordinator gates and the cold/no-page verification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { getDataDir } from "../core/paths.ts";
import {
  deleteAuthSession,
  saveAuthSession,
} from "../core/database.ts";
import { ensureAccountSession } from "../services/qwen-token-refresh.ts";
import { tryAcquireAccountLease } from "../core/account-concurrency.ts";
import {
  getAuthRecoveryState,
  recoverAccountSession,
  resetAuthRecoveryForTests,
  setAuthRecoveryDeps,
  type AuthRecoveryVerification,
} from "../services/auth-recovery.ts";
import { _attemptReloginForTests } from "../routes/chat/account.ts";

let clock = 1_000_000;
let verifyImpl: (id: string) => Promise<AuthRecoveryVerification> = async () => ({
  state: "valid",
  reason: "settings-ok",
});
let activeStream: (id: string) => boolean = () => false;
let busy: (id: string) => boolean = () => false;
let cooldown: (id: string) => boolean = () => false;
let manual: (id: string) => boolean = () => false;
let verifyCalls = 0;
let seededIds: string[] = [];

function seed(id: string): void {
  saveAuthSession(id, {
    cookie: "token=gate-token; refresh_token=gate-refresh",
    userAgent: "Mozilla/5.0 GateTest",
    bxV: "2.5.37",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "gate-refresh",
    capturedAt: Date.now(),
  });
  seededIds.push(id);
}

function setup(): void {
  clock = 1_000_000;
  verifyCalls = 0;
  verifyImpl = async () => ({ state: "valid", reason: "settings-ok" });
  activeStream = () => false;
  busy = () => false;
  cooldown = () => false;
  manual = () => false;
  setAuthRecoveryDeps({
    now: () => clock,
    verifySession: async (id) => {
      verifyCalls += 1;
      return verifyImpl(id);
    },
    hasActiveStream: (id) => activeStream(id),
    isBusy: (id) => busy(id),
    isOnCooldown: (id) => cooldown(id),
    hasActiveManualVerification: async (id) => manual(id),
    recommendManualVerification: () => {},
    blockedBackoffMs: 30_000,
    rejectedBackoffMs: 300_000,
    inconclusiveBackoffMs: 60_000,
    maxInconclusiveAttempts: 3,
  });
}

test.beforeEach(setup);
test.afterEach(() => {
  for (const id of seededIds.splice(0)) {
    try {
      deleteAuthSession(id);
    } catch {}
  }
  resetAuthRecoveryForTests();
});

test("cold account + JWT + no page -> inconclusive/no-live-page, no success", async () => {
  const root = path.resolve(getDataDir());
  assert.ok(
    root === path.resolve("data-test") ||
      root.startsWith(path.resolve(os.tmpdir()) + path.sep),
    `expected isolated test dir, got ${root}`,
  );
  assert.ok(!root.includes("/.local/share/"));
  const id = `gate-cold-no-page-${Date.now()}`;
  deleteAuthSession(id);
  try {
    saveAuthSession(id, {
      cookie: "token=test-token; refresh_token=test-refresh",
      userAgent: "",
      bxV: "2.5.37",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshToken: "test-refresh",
      capturedAt: Date.now(),
    });
    const state = await ensureAccountSession(id);
    assert.equal(state.materialPresent, true);
    assert.equal(state.tokenValid, true);
    assert.equal(state.refreshPerformed, false);
    assert.equal(state.sessionVerified, "inconclusive");
    assert.equal(state.verificationReason, "no-live-page");
    assert.equal(state.pageRequired, true);
  } finally {
    deleteAuthSession(id);
  }
});

test("cold account + valid verifier -> verified", async () => {
  const r = await recoverAccountSession("cold-valid", "cold");
  assert.equal(r.outcome, "verified");
  assert.equal(getAuthRecoveryState("cold-valid"), "verified");
});

test("cold account + rejected verifier -> rejected + manual recommendation", async () => {
  verifyImpl = async () => ({ state: "rejected", reason: "settings-401" });
  const r = await recoverAccountSession("cold-rejected", "cold");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.manualVerificationRecommended, true);
  assert.equal(r.nextAttemptAt, clock + 300_000);
});

test("401 with active lease -> deferred; healthy alternate -> verified", async () => {
  activeStream = (id) => id === "lease-account";
  verifyImpl = async (id) =>
    id === "healthy-alt"
      ? { state: "valid", reason: "settings-ok" }
      : { state: "rejected", reason: "settings-401" };

  const primary = await recoverAccountSession("lease-account", "401");
  assert.equal(primary.outcome, "deferred");
  assert.equal(getAuthRecoveryState("lease-account"), "backoff");

  const alternate = await recoverAccountSession("healthy-alt", "401");
  assert.equal(alternate.outcome, "verified");
  assert.equal(verifyCalls, 1);
});

test("transient inconclusive -> backoff -> later valid", async () => {
  const seq: AuthRecoveryVerification[] = [
    { state: "inconclusive", reason: "timeout" },
    { state: "valid", reason: "settings-ok" },
  ];
  verifyImpl = async () => seq.shift()!;
  const first = await recoverAccountSession("transient", "verify");
  assert.equal(first.outcome, "inconclusive");
  assert.equal(getAuthRecoveryState("transient"), "inconclusive");

  const tooSoon = await recoverAccountSession("transient", "verify");
  assert.equal(tooSoon.outcome, "deferred");

  clock = first.nextAttemptAt;
  const recovered = await recoverAccountSession("transient", "verify");
  assert.equal(recovered.outcome, "verified");
  assert.equal(verifyCalls, 2);
});

test("healthy account remains untouched unless explicitly scheduled", () => {
  assert.equal(getAuthRecoveryState("healthy-fastboot"), "idle");
  assert.equal(verifyCalls, 0);
});

test("401 real caller: verified session continues (true)", async () => {
  seed("gate-401-valid");
  const ok = await _attemptReloginForTests(
    "gate-401-valid",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, true);
  assert.equal(getAuthRecoveryState("gate-401-valid"), "verified");
  assert.equal(verifyCalls, 1);
});

test("401 real caller: rejected session fails over (false)", async () => {
  seed("gate-401-rejected");
  verifyImpl = async () => ({ state: "rejected", reason: "settings-401" });
  const ok = await _attemptReloginForTests(
    "gate-401-rejected",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, false);
  assert.equal(getAuthRecoveryState("gate-401-rejected"), "rejected");
  assert.equal(verifyCalls, 1);
});

test("401 real caller: inconclusive session fails over (false)", async () => {
  seed("gate-401-inconclusive");
  verifyImpl = async () => ({ state: "inconclusive", reason: "timeout" });
  const ok = await _attemptReloginForTests(
    "gate-401-inconclusive",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, false);
  assert.equal(getAuthRecoveryState("gate-401-inconclusive"), "inconclusive");
  assert.equal(verifyCalls, 1);
});

test("401 real caller: own lease does not block verification", async () => {
  seed("gate-own-lease");
  setAuthRecoveryDeps({
    hasActiveStream: (_id, owner) => owner !== "owner-label",
  });
  const ok = await _attemptReloginForTests(
    "gate-own-lease",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, true);
  assert.equal(verifyCalls, 1);
});

test("401 real caller: another request's lease defers and fails over", async () => {
  seed("gate-other-lease");
  setAuthRecoveryDeps({ hasActiveStream: () => true });
  const ok = await _attemptReloginForTests(
    "gate-other-lease",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, false);
  assert.equal(getAuthRecoveryState("gate-other-lease"), "backoff");
  assert.equal(verifyCalls, 0);
});

test("401 real caller: no-live-page is an explicit page-required outcome", async () => {
  seed("gate-page-required");
  verifyImpl = async () => ({
    state: "inconclusive",
    reason: "no-live-page",
    pageRequired: true,
  });
  const ok = await _attemptReloginForTests(
    "gate-page-required",
    "gate@example.com",
    "owner-label",
  );
  assert.equal(ok, false);
  assert.equal(getAuthRecoveryState("gate-page-required"), "backoff");
  assert.equal(verifyCalls, 1);
});

test("real lease ownership: own leaseId proceeds, other lease defers", async () => {
  resetAuthRecoveryForTests();
  setAuthRecoveryDeps({
    verifySession: async () => ({ state: "valid", reason: "settings-ok" }),
  });
  const ownId = "gate-real-own-lease";
  const ownLease = tryAcquireAccountLease(ownId, "owner-label");
  assert.ok(ownLease);
  try {
    const own = await recoverAccountSession(ownId, "401", {
      ownerLeaseId: ownLease!.leaseId,
    });
    assert.equal(own.outcome, "verified");
  } finally {
    ownLease!.release();
  }

  const otherId = "gate-real-other-lease";
  const otherLease = tryAcquireAccountLease(otherId, "other-label");
  assert.ok(otherLease);
  try {
    const other = await recoverAccountSession(otherId, "401", {
      ownerLeaseId: "lease_for_another_request",
    });
    assert.equal(other.outcome, "deferred");
  } finally {
    otherLease!.release();
  }
});
