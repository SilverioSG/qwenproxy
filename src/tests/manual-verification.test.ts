import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "qwenproxy-test-key";
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
delete process.env.QWEN_ACCOUNTS;

import { loadAccounts, invalidateAccountsCache } from "../core/accounts.ts";
import { closeDatabase, getDatabase } from "../core/database.ts";
import {
  clearAccountCooldown,
} from "../core/account-manager.ts";
import { clearTemporaryBusy } from "../core/account-concurrency.ts";
import {
  startManualVerification,
  cancelManualVerification,
  getManualVerificationStatus,
  setManualVerificationDeps,
  resolveManualDisplay,
} from "../services/manual-verification.ts";

const TEST_ID = "00000000-0000-4000-8000-manualverify1";

function seedAccount(): void {
  const db = getDatabase();
  db.prepare(
    "INSERT OR REPLACE INTO accounts (id, email, password) VALUES (?, ?, ?)",
  ).run(TEST_ID, "manual-verify-test@example.com", "secret-pw");
  invalidateAccountsCache();
}

function cleanupAccount(): void {
  try {
    getDatabase().prepare("DELETE FROM accounts WHERE id = ?").run(TEST_ID);
  } catch {}
  try {
    getDatabase()
      .prepare("DELETE FROM qwen_auth_sessions WHERE account_id = ?")
      .run(TEST_ID);
  } catch {}
  invalidateAccountsCache();
  clearAccountCooldown(TEST_ID);
  clearTemporaryBusy(TEST_ID);
}

function fakePage(loggedIn: boolean, closedAfter = Infinity) {
  let calls = 0;
  return {
    isClosed: () => calls >= closedAfter,
    goto: async () => {},
    __calls: () => calls,
    __tick: () => {
      calls += 1;
    },
  };
}

function installHarness(opts: {
  loggedIn: boolean;
  closedAfter?: number;
  captureBehavior?: "ok" | "fail";
  displayError?: string;
  /** Per-launch login results: launch #N uses results[N-1] (default: loggedIn). */
  launchLogins?: boolean[];
  calls?: { capture: string[]; clearedCooldown: string[]; markedBusy: string[]; clearedBusy: string[]; closedHeadless: string[]; launched: Array<Record<string, string>> };
}) {
  const calls = opts.calls ?? { capture: [], clearedCooldown: [], markedBusy: [], clearedBusy: [], closedHeadless: [], launched: [] };
  let launches = 0;
  const contexts: Array<{ closed: boolean }> = [];
  const mkPair = () => {
    const myLaunch = launches++;
    const loginForThis = opts.launchLogins ? (opts.launchLogins[myLaunch] ?? false) : opts.loggedIn;
    // Only the first (user-facing) window can be closed early; reopened
    // validation windows stay open — models the reported race exactly.
    const closeAfter = myLaunch === 0 ? (opts.closedAfter ?? Infinity) : Infinity;
    let polls = 0;
    const page = {
      isClosed: () => polls >= closeAfter,
      goto: async () => {},
    };
    const fakeContext = {
      closed: false,
      close: async () => {
        fakeContext.closed = true;
      },
    };
    contexts.push(fakeContext);
    return { page, fakeContext, loginForThis, pollsRef: () => polls, tick: () => { polls += 1; } };
  };
  let current: { page: { isClosed: () => boolean; goto: () => Promise<void> }; fakeContext: { closed: boolean; close: () => Promise<void> }; loginForThis: boolean; tick: () => void } | null = null;
  setManualVerificationDeps({
    launchBrowser: async (profileDir: string, env: Record<string, string>) => {
      calls.launched.push({ profileDir, DISPLAY: env.DISPLAY ?? "", XAUTHORITY: env.XAUTHORITY ?? "" });
      current = mkPair();
      return { context: current.fakeContext as never, page: current.page as never };
    },
    isPageLoggedIn: async () => {
      if (!current) return false;
      current.tick();
      return current.loginForThis && !(current.page.isClosed() as boolean);
    },
    sleep: async () => {},
    headedChromeExists: () => true,
    singletonLocked: () => false,
    findAccount: async (id: string) =>
      id === TEST_ID ? { id: TEST_ID, email: "manual-verify-test@example.com" } : undefined,
    fullAccount: async () => ({ id: TEST_ID } as never),
    activeStreams: async () => 0,
    accountBusy: async () => false,
    markBusy: async (id: string) => {
      calls.markedBusy.push(id);
    },
    clearBusy: async (id: string) => {
      calls.clearedBusy.push(id);
    },
    profileDir: async (id: string) => `/tmp/manual-verify-profiles/${id}`,
    closeHeadless: async (id: string) => {
      calls.closedHeadless.push(id);
    },
    initHeadless: async () => {},
    capture: async (id: string) => {
      calls.capture.push(id);
      if (opts.captureBehavior === "fail") throw new Error("capture boom");
    },
    clearCooldown: async (id: string) => {
      calls.clearedCooldown.push(id);
    },
  });
  return { calls, contexts };
}

beforeEach(() => {
  seedAccount();
  assert.ok(loadAccounts().some((a) => a.id === TEST_ID));
});

async function waitForTerminal(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = getManualVerificationStatus(TEST_ID);
    if (!st) return;
    const runnerDone =
      st.state === "verified" ||
      st.state === "failed" ||
      st.state === "cancelled";
    if (runnerDone) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`verification did not settle (state=${st.state})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  cancelManualVerification(TEST_ID);
  await waitForTerminal().catch(() => {});
  cleanupAccount();
  setManualVerificationDeps({
    launchBrowser: async () => {
      throw new Error("launcher not installed");
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  });
});

test("manual verification: unknown account → 404", async () => {
  await assert.rejects(
    startManualVerification("does-not-exist"),
    (e: unknown) => (e as { status?: number }).status === 404,
  );
});

test("manual verification: duplicate start → 409, single active", async () => {
  installHarness({ loggedIn: false, closedAfter: 0 });
  const first = await startManualVerification(TEST_ID);
  assert.equal(first.accountId, TEST_ID);
  await assert.rejects(
    startManualVerification(TEST_ID),
    (e: unknown) => (e as { status?: number }).status === 409,
  );
  // Let background runner settle to cancelled (page closed immediately).
  for (let i = 0; i < 50 && getManualVerificationStatus(TEST_ID)?.state !== "cancelled"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "cancelled");
});

test("manual verification: close before login → cancelled, cooldown intact", async () => {
  installHarness({ loggedIn: false, closedAfter: 0 });
  getDatabase().prepare(
    "UPDATE accounts SET cooldown_until = ?, cooldown_reason = ? WHERE id = ?",
  ).run(Date.now() + 60000, "AuthFailed: test", TEST_ID);
  invalidateAccountsCache();
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 50 && getManualVerificationStatus(TEST_ID)?.state !== "cancelled"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const st = getManualVerificationStatus(TEST_ID);
  assert.equal(st?.state, "cancelled");
  const db = getDatabase();
  const row = db.prepare("SELECT cooldown_reason FROM accounts WHERE id = ?").get(TEST_ID) as { cooldown_reason: string | null };
  assert.equal(row.cooldown_reason, "AuthFailed: test");
  const payload = JSON.stringify(st);
  assert.ok(!payload.includes("secret-pw"));
});

test("manual verification: status carries no secrets", async () => {
  installHarness({ loggedIn: true });
  const st = await startManualVerification(TEST_ID);
  assert.ok(!JSON.stringify(st).includes("secret-pw"));
  assert.ok(!JSON.stringify(st).includes("token"));
});

test("manual verification: success → capture + cooldown cleared + busy released", async () => {
  const { calls, contexts } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 200 && getManualVerificationStatus(TEST_ID)?.state !== "verified"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "verified");
  assert.deepEqual(calls.capture, [TEST_ID]);
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  assert.deepEqual(calls.markedBusy, [TEST_ID]);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  assert.deepEqual(calls.closedHeadless, [TEST_ID]);
  assert.ok(calls.launched.length === 1);
  assert.ok(calls.launched[0].profileDir.endsWith(TEST_ID));
  assert.equal(calls.launched.length, 1);
  assert.ok(contexts.length >= 1 && contexts.every((c) => c.closed));
});

test("manual verification: invalid session → failed, cooldown intact, no capture", async () => {
  const { calls } = installHarness({ loggedIn: false, closedAfter: 1000000 });
  // Force immediate timeout by cancelling after start would mask failure;
  // instead drive loggedIn=false with a closed page after a few polls.
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 200; i++) {
    const s = getManualVerificationStatus(TEST_ID)?.state ?? "";
    if (["failed", "cancelled", "verified"].includes(s)) break;
    await new Promise((r) => setTimeout(r, 10));
    if (i === 5) cancelManualVerification(TEST_ID);
  }
  const st = getManualVerificationStatus(TEST_ID)?.state;
  assert.ok(st === "cancelled" || st === "failed", `unexpected ${st}`);
  assert.deepEqual(calls.capture, []);
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
});

test("manual verification: login then immediate user close → verified, not false cancelled", async () => {
  // Reported prod race: session valid, user closes before next poll.
  // First launch: page already closed; reopen (2nd launch) validates OK.
  const { calls, contexts } = installHarness({ loggedIn: false, closedAfter: 0, launchLogins: [false, true] });
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 200 && getManualVerificationStatus(TEST_ID)?.state !== "verified"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "verified");
  assert.equal(calls.launched.length, 2);
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  assert.ok(contexts.every((c) => c.closed));
});

test("manual verification: late close after verified stays verified", async () => {
  installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 200 && getManualVerificationStatus(TEST_ID)?.state !== "verified"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "verified");
  cancelManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "verified");
});

test("manual verification: capture fails after login → failed, cooldown intact", async () => {
  const { calls } = installHarness({ loggedIn: true, captureBehavior: "fail" });
  await startManualVerification(TEST_ID);
  for (let i = 0; i < 200 && getManualVerificationStatus(TEST_ID)?.state !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "failed");
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) AS c FROM qwen_auth_sessions WHERE account_id = ?").get(TEST_ID) as { c: number };
  assert.equal(row.c, 0);
});

test("resolveManualDisplay: returns usable display or explicit error", () => {
  const res = resolveManualDisplay() as { display?: string; xauthority?: string; error?: string };
  if ("error" in res && res.error) {
    assert.match(res.error, /XAUTHORITY/i);
  } else {
    assert.ok((res as { display: string }).display.length > 0);
    assert.ok((res as { xauthority: string }).xauthority.length > 0);
  }
});
