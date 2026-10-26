/**
 * Auth recovery coordinator — Phase 2B isolated tests.
 *
 * No timers, no browser, no DB, no real accounts. The clock and all gates are
 * injected; concurrency is exercised with pending promises.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getAuthRecoveryInFlightCountForTests,
  getAuthRecoveryState,
  recoverAccountSession,
  resetAuthRecoveryForTests,
  scheduleAuthRecovery,
  setAuthRecoveryDeps,
  type AuthRecoveryVerification,
} from "../services/auth-recovery.ts";

let clock = 1_000_000;
let verifyCalls = 0;
let verifyImpl: (accountId: string) => Promise<AuthRecoveryVerification> =
  async () => ({ state: "valid", reason: "settings-ok" });
let activeStream = false;
let busy = false;
let cooldown = false;
let manual = false;
let recommended: string[] = [];

function setup(): void {
  clock = 1_000_000;
  verifyCalls = 0;
  verifyImpl = async () => ({ state: "valid", reason: "settings-ok" });
  activeStream = false;
  busy = false;
  cooldown = false;
  manual = false;
  recommended = [];
  setAuthRecoveryDeps({
    now: () => clock,
    verifySession: async (accountId) => {
      verifyCalls += 1;
      return verifyImpl(accountId);
    },
    hasActiveStream: () => activeStream,
    isBusy: () => busy,
    isOnCooldown: () => cooldown,
    hasActiveManualVerification: async () => manual,
    recommendManualVerification: (accountId, reason) => {
      recommended.push(`${accountId}:${reason ?? "unknown"}`);
    },
    blockedBackoffMs: 30_000,
    rejectedBackoffMs: 300_000,
    inconclusiveBackoffMs: 60_000,
    maxInconclusiveAttempts: 3,
  });
}

test.beforeEach(setup);
test.afterEach(() => resetAuthRecoveryForTests());

test("10 concurrent calls on one account -> one verification", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => recoverAccountSession("one")),
  );
  assert.equal(verifyCalls, 1);
  assert.ok(results.every((r) => r.outcome === "verified"));
  assert.equal(getAuthRecoveryState("one"), "verified");
});

test("two accounts do not share a global lock", async () => {
  let releaseA!: () => void;
  let releaseB!: () => void;
  verifyImpl = (accountId) =>
    new Promise((resolve) => {
      if (accountId === "a") {
        releaseA = () => resolve({ state: "valid", reason: "settings-ok" });
      } else {
        releaseB = () => resolve({ state: "valid", reason: "settings-ok" });
      }
    });
  const pa = recoverAccountSession("a");
  const pb = recoverAccountSession("b");
  assert.equal(getAuthRecoveryInFlightCountForTests(), 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseA();
  releaseB();
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.outcome, "verified");
  assert.equal(b.outcome, "verified");
  assert.equal(verifyCalls, 2);
});

for (const [label, apply, clear] of [
  ["busy", () => (busy = true), () => (busy = false)],
  ["active stream", () => (activeStream = true), () => (activeStream = false)],
  ["cooldown", () => (cooldown = true), () => (cooldown = false)],
  ["manual verification", () => (manual = true), () => (manual = false)],
] as const) {
  test(`${label} -> deferred without verification`, async () => {
    apply();
    const deferred = await recoverAccountSession("acct");
    assert.equal(deferred.outcome, "deferred");
    assert.equal(verifyCalls, 0);
    assert.equal(getAuthRecoveryState("acct"), "backoff");

    clear();
    clock += 30_000;
    const recovered = await recoverAccountSession("acct");
    assert.equal(recovered.outcome, "verified");
    assert.equal(verifyCalls, 1);
  });
}

test("rejected -> backoff + manual recommendation, no immediate retry", async () => {
  verifyImpl = async () => ({ state: "rejected", reason: "settings-401" });
  const first = await recoverAccountSession("rej");
  assert.equal(first.outcome, "rejected");
  assert.equal(first.state, "rejected");
  assert.equal(first.manualVerificationRecommended, true);
  assert.equal(recommended.length, 1);
  assert.equal(first.nextAttemptAt, clock + 300_000);

  const immediate = await recoverAccountSession("rej");
  assert.equal(immediate.outcome, "deferred");
  assert.equal(verifyCalls, 1);

  clock += 300_000;
  const second = await recoverAccountSession("rej");
  assert.equal(second.outcome, "rejected");
  assert.equal(verifyCalls, 2);
});

test("inconclusive -> bounded retry, then long backoff", async () => {
  verifyImpl = async () => ({ state: "inconclusive", reason: "timeout" });
  for (let i = 0; i < 3; i++) {
    const r = await recoverAccountSession("inc");
    assert.equal(r.outcome, "inconclusive");
    if (i < 2) clock = r.nextAttemptAt;
  }
  assert.equal(verifyCalls, 3);
  const bounded = await recoverAccountSession("inc");
  assert.equal(bounded.outcome, "deferred");
  assert.equal(verifyCalls, 3);

  clock = bounded.nextAttemptAt;
  const later = await recoverAccountSession("inc");
  assert.equal(later.outcome, "inconclusive");
  assert.equal(verifyCalls, 4);
});

test("valid -> verified and ready for the existing READY contract", async () => {
  const r = await recoverAccountSession("ok");
  assert.equal(r.outcome, "verified");
  assert.equal(r.state, "verified");
  assert.equal(r.nextAttemptAt, 0);
  assert.equal(r.manualVerificationRecommended, false);
});

test("multiple 401s -> one verification, then deferred (no storm)", async () => {
  verifyImpl = async () => ({ state: "rejected", reason: "settings-401" });
  await Promise.all(
    Array.from({ length: 10 }, () => recoverAccountSession("storm")),
  );
  assert.equal(verifyCalls, 1);
  await Promise.all(
    Array.from({ length: 10 }, () => recoverAccountSession("storm")),
  );
  assert.equal(verifyCalls, 1);
  assert.equal(getAuthRecoveryState("storm"), "rejected");
});

test("reset -> safe idle state", async () => {
  verifyImpl = async () => ({ state: "rejected", reason: "settings-403" });
  await recoverAccountSession("reset");
  assert.notEqual(getAuthRecoveryState("reset"), "idle");
  resetAuthRecoveryForTests();
  assert.equal(getAuthRecoveryState("reset"), "idle");
  setup();
  const r = await recoverAccountSession("reset");
  assert.equal(r.outcome, "verified");
});

test("healthy account is never scheduled by this coordinator", () => {
  assert.equal(getAuthRecoveryState("healthy"), "idle");
  assert.equal(verifyCalls, 0);
});

test("schedule is inert until an explicit recover call", async () => {
  assert.equal(scheduleAuthRecovery("sched", "manual"), "scheduled");
  assert.equal(verifyCalls, 0);
  const r = await recoverAccountSession("sched");
  assert.equal(r.outcome, "verified");
  assert.equal(verifyCalls, 1);
});
