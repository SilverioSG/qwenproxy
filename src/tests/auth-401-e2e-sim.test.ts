/**
 * Simulated 401 through the REAL caller, without browser/Qwen/network.
 *
 * - inner: the real tryCreateStreamWithRetry -> attemptRelogin -> modern
 *   decision path, with only the transport and model sync injected;
 * - outer: the real acquireUpstreamStream rotation, to prove that an upstream
 *   session rejection reaches the healthy alternate while a local AuthError
 *   remains terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AuthError } from "../core/errors.ts";
import {
  deleteAuthSession,
  getDatabase,
  getRefreshMaterial,
  saveAuthSession,
} from "../core/database.ts";
import { invalidateAccountsCache, loadAccounts } from "../core/accounts.ts";
import {
  markAccountHeadersReady,
  unmarkAccountHeadersReady,
} from "../core/account-manager.ts";
import { removeStream } from "../core/stream-registry.ts";
import { QwenSessionExpiredError } from "../services/qwen-errors.ts";
import { isTerminalLocalError } from "../routes/chat/retry-policy.ts";
import {
  getAuthRecoveryState,
  resetAuthRecoveryForTests,
  setAuthRecoveryDeps,
  type AuthRecoveryVerification,
} from "../services/auth-recovery.ts";
import {
  _authMaterialFingerprintForTests,
  _tryCreateStreamWithRetryForTests,
  acquireUpstreamStream,
  type AcquireParams,
  type UpstreamStreamTestDeps,
} from "../routes/chat/account.ts";

const EMAIL_A = "gate401a@example.invalid";
const EMAIL_B = "gate401b@example.invalid";
const UA = "Mozilla/5.0 Gate401";
let previousAccountsEnv: string | undefined;

function fakeSuccess(accountId: string): any {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    headers: {},
    uiSessionId: `sim-chat-${accountId.slice(0, 8)}`,
    controller: new AbortController(),
    accountId,
    createdNewChat: true,
    tokenEstimationContext: {},
  };
}

function seed(id: string): void {
  deleteAuthSession(id);
  saveAuthSession(id, {
    cookie: "token=sim-jwt; refresh_token=sim-refresh; cna=sim",
    userAgent: UA,
    bxV: "2.5.37",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: "sim-refresh",
    capturedAt: Date.now(),
  });
}

function setupAccounts(): { a: string; b: string } {
  previousAccountsEnv = process.env.QWEN_ACCOUNTS;
  process.env.QWEN_ACCOUNTS = `${EMAIL_A}:pw-a\n${EMAIL_B}:pw-b`;
  invalidateAccountsCache();
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.email === EMAIL_A);
  const b = accounts.find((x) => x.email === EMAIL_B);
  assert.ok(a, "account A seeded");
  assert.ok(b, "account B seeded");
  seed(a!.id);
  seed(b!.id);
  markAccountHeadersReady(a!.id);
  markAccountHeadersReady(b!.id);
  return { a: a!.id, b: b!.id };
}

function cleanupAccounts(ids: string[]): void {
  for (const id of ids) {
    unmarkAccountHeadersReady(id);
    try {
      deleteAuthSession(id);
    } catch {}
  }
  if (previousAccountsEnv === undefined) delete process.env.QWEN_ACCOUNTS;
  else process.env.QWEN_ACCOUNTS = previousAccountsEnv;
  invalidateAccountsCache();
  try {
    getDatabase()
      .prepare("DELETE FROM accounts WHERE email IN (?, ?)")
      .run(EMAIL_A, EMAIL_B);
  } catch {}
  resetAuthRecoveryForTests();
}

function acquireParams(preferredAccountId: string): AcquireParams {
  return {
    finalPrompt: "ping",
    fullPrompt: "ping",
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
    forceNewChat: true,
    preferredAccountId,
  };
}

function innerParams(completionId: string): any {
  return {
    ...acquireParams("unused"),
    completionId,
  };
}

function installDeps(
  a: string,
  b: string,
  verifyA: AuthRecoveryVerification,
  calls: string[],
  alwaysFailA = false,
  errorForA?: (accountId: string) => Error,
): UpstreamStreamTestDeps {
  let verifyCalls = 0;
  setAuthRecoveryDeps({
    verifySession: async (id) => {
      if (id === a) {
        verifyCalls += 1;
        return verifyA;
      }
      return { state: "valid", reason: "settings-ok" };
    },
    hasActiveStream: () => false,
    isBusy: () => false,
    isOnCooldown: () => false,
    hasActiveManualVerification: async () => false,
  });
  (installDeps as any).verifyCalls = () => verifyCalls;
  return {
    fetchQwenModels: async () => [],
    createStreamForAccount: (async (args: any) => {
      calls.push(args.accountId);
      if (args.accountId === a) {
        if (alwaysFailA || calls.filter((x) => x === a).length === 1) {
          throw (
            errorForA?.(a) ??
            new QwenSessionExpiredError("simulated upstream 401", a)
          );
        }
      }
      if (args.accountId === b) return fakeSuccess(b);
      throw new QwenSessionExpiredError(
        "simulated upstream 401",
        String(args.accountId),
      );
    }) as any,
  };
}

async function runOuterFailover(
  verifyA: AuthRecoveryVerification,
): Promise<{ calls: string[]; a: string; b: string; result: any }> {
  const { a, b } = setupAccounts();
  const calls: string[] = [];
  try {
    const deps = installDeps(a, b, verifyA, calls);
    const result: any = await acquireUpstreamStream(acquireParams(a), deps);
    return { calls, a, b, result };
  } catch (err) {
    cleanupAccounts([a, b]);
    throw err;
  }
}

test.afterEach(() => resetAuthRecoveryForTests());

test("FACT: upstream session 401 fails over; local AuthError stays terminal", () => {
  assert.equal(
    isTerminalLocalError(new QwenSessionExpiredError("401", "fact-account")),
    false,
  );
  assert.equal(isTerminalLocalError(new AuthError("local api key")), true);
});

test("inner 401 + JWT valid + rejected: one attempt, no freshness success", async () => {
  const a = "inner-rejected-a";
  seed(a);
  const calls: string[] = [];
  try {
    const deps = installDeps(
      a,
      "unused-b",
      { state: "rejected", reason: "settings-401" },
      calls,
    );
    const result: any = await _tryCreateStreamWithRetryForTests(
      innerParams("sim-inner-rejected"),
      a,
      EMAIL_A,
      deps,
    );
    assert.equal(result.success, false);
    assert.deepEqual(calls, [a]);
    assert.equal((installDeps as any).verifyCalls(), 1);
    assert.equal(getAuthRecoveryState(a), "rejected");
  } finally {
    deleteAuthSession(a);
  }
});

test("inner 401 + inconclusive timeout: one attempt, prior material intact", async () => {
  const a = "inner-inconclusive-a";
  seed(a);
  const before = getRefreshMaterial(a);
  const calls: string[] = [];
  try {
    const deps = installDeps(
      a,
      "unused-b",
      { state: "inconclusive", reason: "timeout" },
      calls,
    );
    const result: any = await _tryCreateStreamWithRetryForTests(
      innerParams("sim-inner-inconclusive"),
      a,
      EMAIL_A,
      deps,
    );
    const after = getRefreshMaterial(a);
    assert.equal(result.success, false);
    assert.deepEqual(calls, [a]);
    assert.equal(after?.jar, before?.jar);
    assert.equal(after?.userAgent, before?.userAgent);
    assert.equal(getAuthRecoveryState(a), "inconclusive");
  } finally {
    deleteAuthSession(a);
  }
});

test("inner verified-but-401: second 401 ends the account attempt", async () => {
  const a = "inner-verified-a";
  seed(a);
  const calls: string[] = [];
  try {
    const deps = installDeps(
      a,
      "unused-b",
      { state: "valid", reason: "settings-ok" },
      calls,
      true,
    );
    const result: any = await _tryCreateStreamWithRetryForTests(
      innerParams("sim-inner-verified"),
      a,
      EMAIL_A,
      deps,
    );
    assert.equal(result.success, false);
    assert.deepEqual(calls, [a, a]);
    assert.equal((installDeps as any).verifyCalls(), 1);
  } finally {
    deleteAuthSession(a);
  }
});

test("inner 401 -> verified -> success continues", async () => {
  const a = "inner-verified-success";
  seed(a);
  const calls: string[] = [];
  setAuthRecoveryDeps({
    verifySession: async () => ({ state: "valid", reason: "settings-ok" }),
    hasActiveStream: () => false,
    isBusy: () => false,
    isOnCooldown: () => false,
    hasActiveManualVerification: async () => false,
  });
  let verifyCalls = 0;
  const originalVerify = async () => {
    verifyCalls += 1;
    return { state: "valid" as const, reason: "settings-ok" };
  };
  setAuthRecoveryDeps({ verifySession: originalVerify });
  const deps: UpstreamStreamTestDeps = {
    fetchQwenModels: async () => [],
    createStreamForAccount: (async (args: any) => {
      calls.push(args.accountId);
      if (calls.length === 1) {
        throw new QwenSessionExpiredError("simulated upstream 401", a);
      }
      return fakeSuccess(a);
    }) as any,
  };
  try {
    const result: any = await _tryCreateStreamWithRetryForTests(
      innerParams("sim-inner-verified-success"),
      a,
      EMAIL_A,
      deps,
    );
    assert.equal(result.success, true);
    assert.deepEqual(calls, [a, a]);
    assert.equal(verifyCalls, 1);
    try {
      result.releaseAccountLease?.();
    } catch {}
  } finally {
    deleteAuthSession(a);
  }
});

test("material fingerprint follows real DB renewal, not a settings probe", async () => {
  const a = "material-fingerprint";
  seed(a);
  try {
    const before = await _authMaterialFingerprintForTests(a);
    assert.ok(before);
    const unchanged = await _authMaterialFingerprintForTests(a);
    assert.equal(unchanged, before);

    // A real material renewal changes the persisted row.
    saveAuthSession(a, {
      cookie: "token=renewed-jwt; refresh_token=renewed-refresh; cna=sim",
      userAgent: UA,
      bxV: "2.5.37",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 7200,
      refreshToken: "renewed-refresh",
      capturedAt: Date.now(),
    });
    const renewed = await _authMaterialFingerprintForTests(a);
    assert.ok(renewed);
    assert.notEqual(renewed, before);
  } finally {
    deleteAuthSession(a);
  }
});

test("control: healthy account succeeds through the real inner caller", async () => {
  const b = "inner-healthy-b";
  seed(b);
  const calls: string[] = [];
  try {
    const deps: UpstreamStreamTestDeps = {
      fetchQwenModels: async () => [],
      createStreamForAccount: (async (args: any) => {
        calls.push(args.accountId);
        return fakeSuccess(b);
      }) as any,
    };
    const result: any = await _tryCreateStreamWithRetryForTests(
      innerParams("sim-inner-healthy"),
      b,
      EMAIL_B,
      deps,
    );
    assert.equal(result.success, true);
    assert.deepEqual(calls, [b]);
    try {
      result.releaseAccountLease?.();
    } catch {}
  } finally {
    deleteAuthSession(b);
  }
});

test("OUTER 401 rejected fails over A -> healthy B", async () => {
  const { a, b, calls, result } = await runOuterFailover({
    state: "rejected",
    reason: "settings-401",
  });
  try {
    assert.equal(result.error, undefined, "healthy B must serve");
    assert.equal(result.activeAccountId, b);
    assert.deepEqual(calls, [a, b]);
    assert.equal((installDeps as any).verifyCalls(), 1);
  } finally {
    try {
      result.releaseAccountLease?.();
    } catch {}
    removeStream(result.completionId);
    cleanupAccounts([a, b]);
  }
});

test("OUTER 401 inconclusive fails over A -> healthy B", async () => {
  const { a, b, calls, result } = await runOuterFailover({
    state: "inconclusive",
    reason: "timeout",
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.activeAccountId, b);
    assert.deepEqual(calls, [a, b]);
    assert.equal((installDeps as any).verifyCalls(), 1);
  } finally {
    try {
      result.releaseAccountLease?.();
    } catch {}
    removeStream(result.completionId);
    cleanupAccounts([a, b]);
  }
});

test("OUTER page-required fails over A -> healthy B", async () => {
  const { a, b, calls, result } = await runOuterFailover({
    state: "inconclusive",
    reason: "no-live-page",
    pageRequired: true,
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.activeAccountId, b);
    assert.deepEqual(calls, [a, b]);
    assert.equal((installDeps as any).verifyCalls(), 1);
  } finally {
    try {
      result.releaseAccountLease?.();
    } catch {}
    removeStream(result.completionId);
    cleanupAccounts([a, b]);
  }
});

test("OUTER verified then second 401 stops after 2 attempts and fails over B", async () => {
  const { a, b } = setupAccounts();
  const calls: string[] = [];
  try {
    const deps = installDeps(
      a,
      b,
      { state: "valid", reason: "settings-ok" },
      calls,
      true,
    );
    const result: any = await acquireUpstreamStream(acquireParams(a), deps);
    assert.equal(result.error, undefined);
    assert.equal(result.activeAccountId, b);
    assert.deepEqual(calls, [a, a, b]);
    assert.equal((installDeps as any).verifyCalls(), 1);
    try {
      result.releaseAccountLease?.();
    } catch {}
    removeStream(result.completionId);
  } finally {
    cleanupAccounts([a, b]);
  }
});

test("OUTER local AuthError is terminal, no failover to B", async () => {
  const { a, b } = setupAccounts();
  const calls: string[] = [];
  try {
    const deps = installDeps(
      a,
      b,
      { state: "valid", reason: "settings-ok" },
      calls,
      true,
      () => new AuthError("local invalid api key"),
    );
    const result: any = await acquireUpstreamStream(acquireParams(a), deps);
    assert.ok(result.error instanceof AuthError);
    assert.deepEqual(calls, [a], "local auth error must not rotate");
    assert.equal((installDeps as any).verifyCalls(), 0);
  } finally {
    cleanupAccounts([a, b]);
  }
});
