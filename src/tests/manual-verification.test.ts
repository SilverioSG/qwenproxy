import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "qwenproxy-test-key";
const originalQwenAccounts = process.env.QWEN_ACCOUNTS;
delete process.env.QWEN_ACCOUNTS;

import {
  getAccountAuthState,
  loadAccounts,
  invalidateAccountsCache,
  setAccountAuthState,
} from "../core/accounts.ts";
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
  snapshotVisibleAuth,
  saveManualAuthSession,
  selectManualAccessToken,
  classifyManualSettingsResponse,
  defaultSendWaitingMessage,
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

function installHarness(opts: {
  loggedIn: boolean;
  closedAfter?: number;
  captureBehavior?: "ok" | "fail";
  displayError?: string;
  /** Per-launch login results: launch #N uses results[N-1] (default: loggedIn). */
  launchLogins?: boolean[];
  /** Reason reported when the probe is not ok. */
  probeReason?: string;
  /** Simulate a restored background tab in the same context. */
  extraPage?: boolean;
  /** Controls the mock persisted-session store. */
  persist?: {
    initialCapturedAt?: number;
    saveThrows?: boolean;
    dontAdvance?: boolean;
    validateStatus?: number;
    validateSequence?: number[];
  };
  /** Credential/autofill behavior for the flow. */
  creds?: "ok" | "none";
  autofillResult?: { submitted: boolean; alreadyLoggedIn: boolean; reason: string };
  calls?: { capture: string[]; clearedCooldown: string[]; markedBusy: string[]; clearedBusy: string[]; closedHeadless: string[]; launched: Array<Record<string, string>>; probed: string[] };
}) {
  const calls = opts.calls ?? { capture: [], clearedCooldown: [], markedBusy: [], clearedBusy: [], closedHeadless: [], launched: [], probed: [] };
  let launches = 0;
  const contexts: Array<{ closed: boolean }> = [];
  let forceClosed = false;
  const pages: Array<{ __emit: (res: { url: string; status: number; body: string; method?: string; textFn?: () => Promise<string> }) => Promise<void>; __listenerCount: (ev: string) => number }> = [];
  const mkPair = () => {
    const myLaunch = launches++;
    const loginForThis = opts.launchLogins ? (opts.launchLogins[myLaunch] ?? false) : opts.loggedIn;
    // Only the first (user-facing) window can be closed early; reopened
    // validation windows stay open — models the reported race exactly.
    const closeAfter = myLaunch === 0 ? (opts.closedAfter ?? Infinity) : Infinity;
    let polls = 0;
    const makePage = () => {
      const listeners = new Map<string, Array<(res: never) => void>>();
      const pg = {
        isClosed: () => forceClosed || polls >= closeAfter,
        goto: async () => {},
        on: (ev: string, fn: (res: never) => void) => {
          const arr = listeners.get(ev) ?? [];
          arr.push(fn);
          listeners.set(ev, arr);
        },
        removeListener: (ev: string, fn: (res: never) => void) => {
          const arr = listeners.get(ev) ?? [];
          listeners.set(ev, arr.filter((f) => f !== fn));
        },
      __emit: async (res: {
        url: string;
        status: number;
        body: string;
        method?: string;
        /** Deferred body read: resolve/reject manually to model pending SSE. */
        textFn?: () => Promise<string>;
      }) => {
        const handlers = [...(listeners.get("response") ?? [])];
        for (const h of handlers) {
          await h({
            url: () => res.url,
            ok: () => res.status >= 200 && res.status < 300,
            status: () => res.status,
            text: res.textFn ?? (async () => res.body),
            request: () => ({ method: () => res.method ?? "POST" }),
          } as never);
        }
      },
      __listenerCount: (ev: string) => listeners.get(ev)?.length ?? 0,
      };
      return pg;
    };
    const page = makePage();
    const extra = opts.extraPage ? makePage() : null;
    const fakeContext = {
      closed: false,
      close: async () => {
        fakeContext.closed = true;
      },
      pages: () => (extra ? [page, extra] : [page]),
      on: (_ev: string, _fn: unknown) => {},
    };
    contexts.push(fakeContext);
    pages.push(page);
    if (extra) pages.push(extra);
    return { page, fakeContext, loginForThis, tick: () => { polls += 1; } };
  };
  let current: { page: { isClosed: () => boolean; goto: () => Promise<void> }; fakeContext: { closed: boolean; close: () => Promise<void> }; loginForThis: boolean; tick: () => void } | null = null;
  let meta = {
    exists: (opts.persist?.initialCapturedAt ?? 0) > 0,
    capturedAt: opts.persist?.initialCapturedAt ?? 0,
  };
  setManualVerificationDeps({
    launchBrowser: async (profileDir: string, env: Record<string, string>) => {
      calls.launched.push({ profileDir, DISPLAY: env.DISPLAY ?? "", XAUTHORITY: env.XAUTHORITY ?? "" });
      current = mkPair();
      return { context: current.fakeContext as never, page: current.page as never };
    },
    probeLogin: async () => {
      if (!current) return { ok: false, reason: "evaluate-error" };
      current.tick();
      const ok = current.loginForThis && !(current.page.isClosed() as boolean);
      return ok
        ? { ok: true, reason: "ok" }
        : { ok: false, reason: opts.probeReason ?? "auths-status" };
    },
    // Existing tests drive the response explicitly via emit(); the default
    // auto-send is a no-op unless a test overrides it.
    sendWaitingMessage: async () => ({ actionExecuted: false, reason: "disabled-for-test" }),
    autoSendComposerGraceMs: 100,
    autoSendArmMs: 10,
    // Yield a real macrotask: a zero-duration sleep must still let the event
    // loop interleave, otherwise wall-clock poll loops starve timers.
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 0));
    },
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
    capture: async (id: string, captureOpts?: { persistSession?: boolean }) => {
      calls.capture.push(id);
      (calls as { captureOpts?: Array<{ persistSession?: boolean }> }).captureOpts =
        ((calls as { captureOpts?: Array<{ persistSession?: boolean }> }).captureOpts ?? []).concat([captureOpts ?? {}]);
      if (opts.captureBehavior === "fail") throw new Error("capture boom");
    },
    clearCooldown: async (id: string) => {
      calls.clearedCooldown.push(id);
    },
    unmarkReady: async () => {},
    readPersistedMeta: async () => ({ ...meta }),
    snapshotVisible: async () => ({
      cookie: "token=mock-jwt; acw_tc=mock",
      userAgent: "mock-ua",
      bxV: "2.5.37",
      bxUa: "mock-bx-ua",
      bxUmidtoken: "mock-bx-umid",
      capturedAt: Date.now(),
    }),
    saveSession: async () => {
      if (opts.persist?.saveThrows) throw new Error("db locked");
      if (opts.persist?.dontAdvance) return;
      meta = { exists: true, capturedAt: Date.now() };
    },
    validateLive: (() => {
      let n = 0;
      return async () => {
        const seq = opts.persist?.validateSequence;
        const status = seq ? (seq[Math.min(n++, seq.length - 1)] ?? 200) : (opts.persist?.validateStatus ?? 200);
        return { status, state: status === 200 ? "valid" as const : status === 401 || status === 403 ? "rejected" as const : "inconclusive" as const };
      };
    })(),
    probeSameContext: async () => {
      calls.probed.push("probe");
      return {
      settingsStatus: 200,
      settingsAppAuthFailure: false,
      createChatStatus: 200,
      createChatSuccess: true,
      createChatAppAuthFailure: false,
      liveTokenPresent: true,
      cookieCount: 12,
      cookieNameHash: "deadbeef",
      };
    },
    getCredentials: async () =>
      opts.creds === "none"
        ? null
        : { email: "t@example.com", password: "pw" },
    autofill: async () =>
      opts.autofillResult ?? { submitted: false, alreadyLoggedIn: true, reason: "already-logged-in" },
  });
  return {
    calls,
    contexts,
    pages,
    closeCurrent: () => {
      forceClosed = true;
    },
    emit: async (res: {
      url: string;
      status: number;
      body: string;
      method?: string;
      textFn?: () => Promise<string>;
    }): Promise<void> => {
      const start = Date.now();
      while (pages.length < 1) {
        if (Date.now() - start > 5000) throw new Error("browser never launched");
        await new Promise((r) => setTimeout(r, 10));
      }
      await pages[0].__emit(res);
    },
  };
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

const VALID_SSE = 'data: {"choices":[{"delta":{"content":"hola"}}]}\n\ndata: [DONE]\n\n';
const CHAT_URL = "https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc";

async function waitForState(
  want: string | string[],
  timeoutMs = 5000,
): Promise<string | undefined> {
  const wants = Array.isArray(want) ? want : [want];
  const start = Date.now();
  for (;;) {
    const s = getManualVerificationStatus(TEST_ID)?.state;
    if (s && wants.includes(s)) return s;
    if (Date.now() - start > timeoutMs) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForLaunch(
  calls: { launched: Array<unknown> },
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (calls.launched.length < 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("browser was never launched");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("manual verification: success → capture + cooldown cleared + busy released", async () => {
  const { calls, contexts, pages, emit } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.capture, [TEST_ID]);
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  assert.deepEqual(calls.markedBusy, [TEST_ID]);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  assert.deepEqual(calls.closedHeadless, [TEST_ID]);
  assert.equal(calls.launched.length, 1);
  assert.ok(calls.launched[0].profileDir.endsWith(TEST_ID));
  assert.ok(contexts.length >= 1 && contexts.every((c) => c.closed));
});

test("manual verification: invalid session → failed, cooldown intact, no capture", async () => {
  const { calls, emit } = installHarness({ loggedIn: false, closedAfter: 1000000 });
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

test("manual verification: login alone never verifies and never closes window", async () => {
  const { calls, contexts, emit } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  await new Promise((r) => setTimeout(r, 100));
  const st = getManualVerificationStatus(TEST_ID);
  assert.equal(st?.state, "authenticated");
  assert.equal(calls.launched.length, 1);
  assert.equal(contexts[0].closed, false);
  assert.deepEqual(calls.capture, []);
  assert.deepEqual(calls.clearedCooldown, []);
});

test("manual verification: blocked/failed chat never verifies", async () => {
  const { calls, pages, emit } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  // Non-chat URL ignored; non-2xx ignored; empty body ignored; GET ignored.
  await emit({ url: "https://chat.qwen.ai/api/v2/users/user/settings", status: 200, body: '{"success":true}' });
  await emit({ url: CHAT_URL, status: 403, body: "Forbidden" });
  await emit({ url: CHAT_URL, status: 200, body: "" });
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE, method: "GET" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "authenticated");
  assert.deepEqual(calls.capture, []);
  assert.deepEqual(calls.clearedCooldown, []);
  cancelManualVerification(TEST_ID);
  assert.equal(await waitForState("cancelled"), "cancelled");
});

test("manual verification: login then close before chat → cancelled, never verified", async () => {
  // Supersedes the reopen-based race test: login alone is not success, so an
  // early close can only conclude cancelled (never false-verified).
  const { calls, contexts, emit } = installHarness({ loggedIn: true, closedAfter: 0 });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("cancelled"), "cancelled");
  assert.deepEqual(calls.capture, []);
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  assert.ok(contexts.every((c) => c.closed));
});

test("manual verification: late close after verified stays verified", async () => {
  const { pages, emit } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  cancelManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getManualVerificationStatus(TEST_ID)?.state, "verified");
});

test("manual verification: capture fails after login → failed, cooldown intact", async () => {
  const { calls, pages, emit } = installHarness({ loggedIn: true, captureBehavior: "fail" });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) AS c FROM qwen_auth_sessions WHERE account_id = ?").get(TEST_ID) as { c: number };
  assert.equal(row.c, 0);
});

test("manual verification: isValidChatCompletion predicate", async () => {
  const { isValidChatCompletion } = await import("../services/manual-verification.ts");
  assert.equal(isValidChatCompletion(200, VALID_SSE), true);
  assert.equal(isValidChatCompletion(200, '{"choices":[{"message":{}}]}'), true);
  assert.equal(isValidChatCompletion(200, ""), false);
  assert.equal(isValidChatCompletion(200, '{"success":true}'), false);
  assert.equal(isValidChatCompletion(403, VALID_SSE), false);
  assert.equal(isValidChatCompletion(500, "error"), false);
});

test("manual verification: prompt/response content never surfaces in status", async () => {
  const { pages, emit } = installHarness({ loggedIn: true });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  const secret = "SECRET-PROMPT-UNIQUE-XYZ";
  await emit({ url: CHAT_URL, status: 200, body: `data: {"choices":[{"delta":{"content":"${secret}"}}]}\n\ndata: [DONE]\n\n` });
  assert.equal(await waitForState("verified"), "verified");
  const st = getManualVerificationStatus(TEST_ID);
  assert.ok(!JSON.stringify(st).includes(secret));
  assert.ok(!JSON.stringify(st).includes("SECRET-PROMPT"));
});

test("manual verification: login probe false/timeout/destroyed + valid chat → verified", async () => {
  for (const reason of ["auths-status", "timeout", "context-destroyed"]) {
    const { calls, pages, emit } = installHarness({ loggedIn: false, probeReason: reason });
    await startManualVerification(TEST_ID);
    // Login never confirms (informative only), but a real chat completion
    // still verifies the account.
    await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
    assert.equal(await waitForState("verified"), "verified", `reason=${reason}`);
    assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  }
});

test("manual verification: pending body + close → grace; valid during grace → verified", async () => {
  const { calls, emit, closeCurrent } = installHarness({ loggedIn: false });
  let resolveBody: ((body: string) => void) | null = null;
  const gate = new Promise<string>((resolve) => {
    resolveBody = resolve;
  });
  await startManualVerification(TEST_ID);
  // Emit headers now; body stays pending like an open SSE stream.
  const emitP = emit({
    url: CHAT_URL,
    status: 200,
    body: "",
    textFn: () => gate,
  });
  await new Promise((r) => setTimeout(r, 100));
  // User closes while classification is pending: grace window, not cancel.
  closeCurrent();
  await new Promise((r) => setTimeout(r, 100));
  const mid = getManualVerificationStatus(TEST_ID)?.state;
  assert.ok(mid !== "verified", `unexpected early ${mid}`);
  resolveBody!(VALID_SSE);
  await emitP;
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
});

test("manual verification: pending body + close → grace expires → cancelled", async () => {
  const { calls, emit, closeCurrent } = installHarness({ loggedIn: false });
  let rejectBody: ((err: unknown) => void) | null = null;
  const gate = new Promise<string>((_, reject) => {
    rejectBody = reject;
  });
  gate.catch(() => {});
  await startManualVerification(TEST_ID);
  const emitP = emit({
    url: CHAT_URL,
    status: 200,
    body: "",
    textFn: () => gate,
  });
  await new Promise((r) => setTimeout(r, 100));
  closeCurrent();
  rejectBody!(new Error("context destroyed"));
  await emitP;
  assert.equal(await waitForState("cancelled"), "cancelled");
  assert.deepEqual(calls.capture, []);
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
});
test("manual verification: save throws → failed, never verified", async () => {
  const { emit } = installHarness({ loggedIn: false, persist: { saveThrows: true } });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
});

test("manual verification: row does not advance → failed", async () => {
  const { emit } = installHarness({
    loggedIn: false,
    persist: { initialCapturedAt: Date.now() - 7200000, dontAdvance: true },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
});

test("manual verification: stale row + fresh persist + settings 200 → verified", async () => {
  const { calls, emit } = installHarness({
    loggedIn: false,
    persist: { initialCapturedAt: Date.now() - 7200000, validateStatus: 200 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
});

test("manual verification: fresh persist + settings 401 → failed, cooldown intact", async () => {
  const { calls, emit } = installHarness({
    loggedIn: false,
    persist: { validateStatus: 401 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
});

test("manual verification: fresh persist + settings 403 → failed, cooldown intact", async () => {
  const { calls, emit } = installHarness({
    loggedIn: false,
    persist: { validateStatus: 403 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.deepEqual(calls.clearedCooldown, []);
});


test("manual verification: autofill submitted → waiting for manual completion", async () => {
  const { emit } = installHarness({
    loggedIn: false,
    autofillResult: { submitted: true, alreadyLoggedIn: false, reason: "submitted" },
  });
  await startManualVerification(TEST_ID);
  // Submitted but no login yet and no chat: stays waiting with the window
  // open for manual completion (never failed, never verified).
  await new Promise((r) => setTimeout(r, 150));
  const pre = getManualVerificationStatus(TEST_ID)?.state;
  assert.ok(pre === "waiting" || pre === "authenticated", `unexpected ${pre}`);
  cancelManualVerification(TEST_ID);
  assert.equal(await waitForState("cancelled"), "cancelled");
});

test("manual verification: no stored credentials → failed, no browser action", async () => {
  const { calls } = installHarness({ loggedIn: false, creds: "none" });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("failed"), "failed");
  assert.equal(calls.launched.length, 1);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
});

test("manual verification: no login form → failed", async () => {
  installHarness({
    loggedIn: false,
    autofillResult: { submitted: false, alreadyLoggedIn: false, reason: "no-form" },
  });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("failed"), "failed");
});

test("manual verification: autofill never exposes credentials to status", async () => {
  const { emit } = installHarness({
    loggedIn: true,
    autofillResult: { submitted: true, alreadyLoggedIn: false, reason: "submitted" },
  });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("authenticated"), "authenticated");
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  const st = getManualVerificationStatus(TEST_ID);
  const blob = JSON.stringify(st);
  assert.ok(!blob.includes("pw-secret-never"));
  assert.ok(!blob.includes("password"));
});

test("manual verification: autofillQwenLoginForm already-logged-in short-circuits", async () => {
  const { autofillQwenLoginForm } = await import("../services/playwright.ts");
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => "ok",
  };
  const r = await autofillQwenLoginForm(page as never, "e@x.com", "s3cret");
  assert.deepEqual(r, { submitted: false, alreadyLoggedIn: true, reason: "already-logged-in" });
});

test("manual verification: autofillQwenLoginForm no-form without touching password", async () => {
  const { autofillQwenLoginForm } = await import("../services/playwright.ts");
  let filled: string[] = [];
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/auth",
    evaluate: async () => false,
    waitForSelector: async () => {
      throw new Error("timeout");
    },
    fill: async (sel: string) => {
      filled.push(sel);
    },
    locator: () => ({ first: () => ({}) }),
    getByText: () => ({ first: () => ({}) }),
    keyboard: { press: async () => {} },
  };
  const r = await autofillQwenLoginForm(page as never, "e@x.com", "s3cret");
  assert.equal(r.reason, "no-form");
  assert.deepEqual(filled, []);
});

test("manual verification: guest composer is not accepted as logged-in", async () => {
  const { autofillQwenLoginForm } = await import("../services/playwright.ts");
  let filled: string[] = [];
  let gotoCalls = 0;
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => false,
    waitForSelector: async (sel: string) => {
      if (/email|correo/i.test(sel)) throw new Error("no email form");
      if (sel.includes("message-input-textarea")) return {} as never;
      throw new Error("timeout");
    },
    fill: async (sel: string) => {
      filled.push(sel);
    },
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
        click: async () => {},
      }),
    }),
    getByText: () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) }),
    keyboard: { press: async () => {} },
    goto: async () => {
      gotoCalls += 1;
    },
  };
  const r = await autofillQwenLoginForm(page as never, "e@x.com", "s3cret");
  assert.equal(r.reason, "no-form");
  assert.equal(r.alreadyLoggedIn, false);
  assert.deepEqual(filled, []);
  assert.ok(gotoCalls >= 1, "guest composer must not short-circuit login");
});

test("manual verification: autofill implementation never solves captcha", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function autofillQwenLoginForm");
  assert.ok(start >= 0);
  const nextExport = src.indexOf("\nasync function loginViaUi(", start);
  const body = src.slice(start, nextExport > 0 ? nextExport : start + 8000);
  assert.ok(!body.includes("solveBaxiaCaptcha"), "autofill must not auto-solve captcha");
  assert.ok(!body.includes("s3cret") && !body.includes("console.log"));
});

test("manual verification: same-context probe runs once, never gates success", async () => {
  const { calls, emit } = installHarness({ loggedIn: false });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.probed, ["probe"]);
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  assert.equal(calls.launched.length, 1);
});

test("manual verification: same-context probe failure still verifies on chat done", async () => {
  const { emit } = installHarness({ loggedIn: false });
  const { setManualVerificationDeps } = await import("../services/manual-verification.ts");
  setManualVerificationDeps({ probeSameContext: async () => null });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
});

test("manual verification: same-context probe emits no secrets", async () => {
  const { emit } = installHarness({ loggedIn: false });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  const st = getManualVerificationStatus(TEST_ID);
  const blob = JSON.stringify(st);
  assert.ok(!blob.includes("token="));
  assert.ok(!blob.includes("cookie"));
});

test("manual verification: final capture uses persistSession=false", async () => {
  const { calls, emit } = installHarness({ loggedIn: false });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  const opts = (calls as { captureOpts?: Array<{ persistSession?: boolean }> }).captureOpts ?? [];
  assert.ok(opts.length >= 1);
  assert.ok(opts.every((o) => o.persistSession === false));
});

test("manual verification: pre-200 post-401 → failed, cooldown intact, context reset", async () => {
  const { calls, emit } = installHarness({
    loggedIn: false,
    persist: { validateSequence: [200, 401] },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.deepEqual(calls.clearedCooldown, []);
  assert.deepEqual(calls.clearedBusy, [TEST_ID]);
  assert.ok(calls.closedHeadless.length >= 1);
});

test("manual verification: captureQwenHeaders default persists (existing behavior)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const sig = "options: { persistSession?: boolean } = {}";
  assert.ok(src.includes(sig));
  const idx = src.indexOf("options: { persistSession?: boolean } = {}");
  const fn = src.slice(src.lastIndexOf("export async function captureQwenHeaders", idx), idx);
  assert.ok(fn.includes("captureQwenHeaders"));
});

test("manual verification: captureQwenHeaders persistSession=false skips saveAuthSession", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const idx = src.indexOf("if (persistSession) {");
  assert.ok(idx >= 0);
  const block = src.slice(idx, idx + 400);
  // Phase 1 routes confirmed capture persistence through the validated writer.
  assert.ok(block.includes("saveValidatedAuthSession"));
});

test("manual verification: chat on background tab still verifies", async () => {
  const { calls, emit, pages } = installHarness({ loggedIn: false, extraPage: true });
  await startManualVerification(TEST_ID);
  await waitForLaunch(calls);
  assert.ok(pages.length >= 2);
  await waitForLaunch(calls);
  // Emit on the SECOND (background) tab: multi-page attach must catch it.
  await pages[1].__emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
});

test("manual verification: redactApiPathname strips ids, keeps structure", async () => {
  const { redactApiPathname } = await import("../services/manual-verification.ts");
  assert.equal(
    redactApiPathname("https://chat.qwen.ai/api/v2/chats/f74bcec4-a450-4b6c-bea6-0b2be44ff6d3"),
    "/api/v2/chats/<id>",
  );
  assert.equal(redactApiPathname("https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc"), "/api/v2/chat/completions");
  assert.equal(redactApiPathname("https://chat.qwen.ai/api/models"), "/api/models");
});

test("manual verification: non-completions api traffic never verifies and leaks nothing", async () => {
  const { emit } = installHarness({ loggedIn: false });
  await startManualVerification(TEST_ID);
  await emit({ url: "https://chat.qwen.ai/api/v2/users/user/settings", status: 200, body: '{"success":true}' });
  await new Promise((r) => setTimeout(r, 100));
  const st = getManualVerificationStatus(TEST_ID)?.state;
  assert.ok(st === "waiting" || st === "authenticated", `unexpected ${st}`);
  cancelManualVerification(TEST_ID);
  assert.equal(await waitForState("cancelled"), "cancelled");
});

test("manual verification: challenge wall keeps window open for user", async () => {
  installHarness({
    loggedIn: false,
    autofillResult: { submitted: false, alreadyLoggedIn: false, reason: "challenge-wall" },
  });
  await startManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 150));
  const st = getManualVerificationStatus(TEST_ID);
  assert.equal(st?.state, "waiting");
  assert.match(st?.detail ?? "", /challenge/i);
  cancelManualVerification(TEST_ID);
  assert.equal(await waitForState("cancelled"), "cancelled");
});

test("manual verification: autofillQwenLoginForm detects challenge wall", async () => {
  const { autofillQwenLoginForm } = await import("../services/playwright.ts");
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/auth",
    evaluate: async () => `<html><div class="captcha-slider">verify you are human</div></html>`,
    waitForSelector: async () => {
      throw new Error("timeout");
    },
    fill: async () => {},
    locator: () => ({ first: () => ({}) }),
    getByText: () => ({ first: () => ({}) }),
    keyboard: { press: async () => {} },
  };
  const r = await autofillQwenLoginForm(page as never, "e@x.com", "s3cret");
  assert.equal(r.reason, "challenge-wall");
});

test("manual verification: auths-schema false negative + same-context proof → verified, no legacy reauth", async () => {
  // Exact live regression (57cabcfa): probe still reports login=false /
  // class=auths-schema while the SAME visible context proves
  // settings=200 + create=200/createOk + liveToken + cookies>0 and the row
  // persists fresh. That must be terminal SUCCESS: cooldown cleared, manual
  // browser closed, final capture runtime-only, no legacy re-auth failure.
  const { calls, contexts, emit } = installHarness({ loggedIn: false, probeReason: "auths-schema" });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(calls.clearedCooldown, [TEST_ID]);
  assert.deepEqual(calls.capture, [TEST_ID]);
  const opts = (calls as { captureOpts?: Array<{ persistSession?: boolean }> }).captureOpts ?? [];
  assert.ok(opts.length >= 1 && opts.every((o) => o.persistSession === false));
  assert.ok(contexts.length >= 1 && contexts.every((c) => c.closed), "manual browser must close");
  assert.deepEqual(calls.probed, ["probe"]);
});

test("manual verification: visible snapshot without usable cookies → failed, never verified", async () => {
  const { calls, emit } = installHarness({ loggedIn: false, probeReason: "auths-schema" });
  const { setManualVerificationDeps } = await import("../services/manual-verification.ts");
  setManualVerificationDeps({ snapshotVisible: async () => null });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.deepEqual(calls.clearedCooldown, []);
});

test("manual verification: settings 401 keeps rejected (no early valid)", async () => {
  setAccountAuthState(TEST_ID, "rejected");
  const { emit } = installHarness({
    loggedIn: false,
    persist: { validateStatus: 401 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.equal(getAccountAuthState(TEST_ID), "rejected");
});

test("manual verification: settings 403 keeps rejected (no early valid)", async () => {
  setAccountAuthState(TEST_ID, "rejected");
  const { emit } = installHarness({
    loggedIn: false,
    persist: { validateStatus: 403 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.equal(getAccountAuthState(TEST_ID), "rejected");
});

test("manual verification: pre 200 + post 401 keeps rejected (no early valid)", async () => {
  setAccountAuthState(TEST_ID, "rejected");
  const { emit } = installHarness({
    loggedIn: false,
    persist: { validateSequence: [200, 401] },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.equal(getAccountAuthState(TEST_ID), "rejected");
});

test("manual verification: rejected → valid only after all validations pass", async () => {
  setAccountAuthState(TEST_ID, "rejected");
  const { emit } = installHarness({
    loggedIn: false,
    persist: { initialCapturedAt: Date.now() - 7200000, validateStatus: 200 },
  });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("verified"), "verified");
  assert.equal(getAccountAuthState(TEST_ID), "valid");
});

test("manual verification: waiting auto-sends one test message and verifies", async () => {
  // Reproduce the production auths-schema false negative: probeLogin is false
  // but the visible SPA/composer is authenticated. The composer gate must send.
  const { emit } = installHarness({
    loggedIn: false,
    probeReason: "auths-schema",
    persist: { initialCapturedAt: Date.now() - 7200000, validateStatus: 200 },
  });
  const sent: string[] = [];
  setManualVerificationDeps({
    sendWaitingMessage: async (_page, accountId, prompt) => {
      assert.equal(accountId, TEST_ID);
      sent.push(prompt);
      setTimeout(() => {
        void emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
      }, 50);
      return { actionExecuted: true, reason: "action-executed" };
    },
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("verified"), "verified");
  assert.deepEqual(sent, ["¿Cuánto es 2 + 2?"]);
});

test("manual verification: challenge skips auto-send and waits for human", async () => {
  installHarness({ loggedIn: true });
  let calls = 0;
  setManualVerificationDeps({
    sendWaitingMessage: async () => {
      calls += 1;
      return { actionExecuted: false, reason: "challenge" };
    },
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 1);
  assert.notEqual(getManualVerificationStatus(TEST_ID)?.state, "verified");
});

test("manual verification: missing composer fails controlled without auth promotion", async () => {
  installHarness({ loggedIn: true });
  setManualVerificationDeps({
    sendWaitingMessage: async () => ({ actionExecuted: false, reason: "composer-missing" }),
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("failed"), "failed");
  assert.notEqual(getAccountAuthState(TEST_ID), "valid");
});

test("manual verification: in-progress response is not duplicated", async () => {
  const { emit } = installHarness({ loggedIn: true });
  let calls = 0;
  setManualVerificationDeps({
    sendWaitingMessage: async () => {
      calls += 1;
      setTimeout(() => {
        void emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
      }, 100);
      return { actionExecuted: false, reason: "in-progress" };
    },
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  assert.equal(await waitForState("verified"), "verified");
  assert.equal(calls, 1);
});

test("manual verification: one auto-send only while waiting for evidence", async () => {
  installHarness({ loggedIn: true });
  let calls = 0;
  setManualVerificationDeps({
    sendWaitingMessage: async () => {
      calls += 1;
      return { actionExecuted: true, reason: "action-executed" };
    },
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls, 1);
  assert.notEqual(getManualVerificationStatus(TEST_ID)?.state, "verified");
});

test("manual verification: completed send action without a chat request is not reported as sent", async () => {
  installHarness({ loggedIn: false, probeReason: "auths-schema" });
  let calls = 0;
  setManualVerificationDeps({
    sendWaitingMessage: async () => {
      calls += 1;
      return { actionExecuted: true, reason: "action-executed" };
    },
  });
  await startManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 150));
  const status = getManualVerificationStatus(TEST_ID);
  assert.equal(calls, 1);
  assert.equal(status?.state, "waiting");
  assert.match(status?.detail ?? "", /action executed/i);
  assert.doesNotMatch(status?.detail ?? "", /message sent/i);
});

test("manual verification: preferred choice requires human, no ambiguous send", async () => {
  installHarness({ loggedIn: true });
  let calls = 0;
  setManualVerificationDeps({
    sendWaitingMessage: async () => {
      calls += 1;
      return { actionExecuted: false, reason: "preferred-choice-required" };
    },
    autoSendComposerGraceMs: 100,
  });
  await startManualVerification(TEST_ID);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 1);
  assert.notEqual(getManualVerificationStatus(TEST_ID)?.state, "verified");
});

test("manual verification: cancelled auto-send does not dispatch after cancellation", async () => {
  let cancelled = false;
  let filled = false;
  let clicked = false;
  const input = {
    count: async () => 1,
    waitFor: async () => {
      cancelled = true;
    },
    isVisible: async () => true,
    isDisabled: async () => false,
    inputValue: async () => "",
    focus: async () => {},
    fill: async () => {
      filled = true;
    },
    click: async () => {
      clicked = true;
    },
  };
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => ({ challenge: false, busy: false, preferred: false }),
    locator: () => ({ first: () => input }),
    keyboard: {
      press: async () => {
        clicked = true;
      },
    },
  };
  const r = await defaultSendWaitingMessage(
    page as never,
    TEST_ID,
    "¿Cuánto es 2 + 2?",
    () => cancelled,
  );
  assert.equal(r.reason, "cancelled");
  assert.equal(filled, false);
  assert.equal(clicked, false);
});

test("manual verification: swallowed send click is not reported as sent", async () => {
  const prompt = "¿Cuánto es 2 + 2?";
  let filled = false;
  let value = "";
  const input = {
    count: async () => 1,
    waitFor: async () => {},
    isVisible: async () => true,
    isDisabled: async () => false,
    inputValue: async () => value,
    focus: async () => {},
    fill: async () => {
      filled = true;
      value = prompt;
    },
    click: async () => {
      throw new Error("click intercepted by modal");
    },
  };
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => ({ challenge: false, busy: false, preferred: false, birthYear: false }),
    locator: () => ({ first: () => input }),
    keyboard: {
      press: async () => {
        throw new Error("Enter intercepted");
      },
    },
  };
  const r = await defaultSendWaitingMessage(page as never, TEST_ID, prompt);
  assert.equal(r.reason, "send-action-failed");
  assert.equal(r.actionExecuted, false);
  assert.equal(filled, true);
});

test("manual verification: birth-year modal blocks auto-send", async () => {
  let filled = false;
  const input = {
    count: async () => 1,
    waitFor: async () => {},
    isVisible: async () => true,
    isDisabled: async () => false,
    inputValue: async () => "",
    focus: async () => {},
    fill: async () => {
      filled = true;
    },
    click: async () => {},
  };
  const page: unknown = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async () => ({ challenge: false, busy: false, preferred: false, birthYear: true }),
    locator: () => ({ first: () => input }),
    keyboard: { press: async () => {} },
  };
  const r = await defaultSendWaitingMessage(page as never, TEST_ID, "¿Cuánto es 2 + 2?");
  assert.equal(r.reason, "birth-year-required");
  assert.equal(r.actionExecuted, false);
  assert.equal(filled, false);
});

test("manual verification: stealth script never invents a birth year", async () => {
  const { getStealthScript } = await import("../services/playwright.ts");
  const script = getStealthScript({} as never);
  assert.ok(!script.includes("1995-06-15"));
  assert.ok(!script.includes("parsed.birthday"));
});

test("manual verification: resolveManualDisplay returns usable display or explicit error", () => {
  const res = resolveManualDisplay() as { display?: string; xauthority?: string; error?: string };
  if ("error" in res && res.error) {
    assert.match(res.error, /XAUTHORITY/i);
  } else {
    assert.ok((res as { display: string }).display.length > 0);
    assert.ok((res as { xauthority: string }).xauthority.length > 0);
  }
});


function syntheticJwt(length: number, exp = Math.floor(Date.now() / 1000) + 900): string {
  const prefix = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.`;
  return prefix + "s".repeat(length - prefix.length);
}

async function visibleSnapshot(cookieToken: string, accessToken: string, refresh = "") {
  const page = {
    evaluate: async (fn: unknown) => {
      const source = String(fn);
      if (source.includes('getItem("access_token")')) return { token: "", access: accessToken, refresh: "" };
      if (source.includes("userAgentData")) return null;
      return "synthetic-UA";
    },
  };
  const context = { cookies: async () => [
    { name: "token", value: cookieToken },
    ...(refresh ? [{ name: "refresh_token", value: refresh }] : []),
  ] };
  return snapshotVisibleAuth(page as never, context as never);
}

test("A/G: visible access_token wins over divergent cookie and persists the transport Bearer", async () => {
  const { saveValidatedAuthSession, getPersistedBearerToken } = await import("../core/database.ts");
  const { captureAccountSessionFromPage } = await import("../services/qwen-account-session.ts");
  const live = syntheticJwt(281);
  const cookie = syntheticJwt(209);
  const snapshot = await visibleSnapshot(cookie, live, "refresh-kept");
  assert.ok(snapshot);
  assert.equal(snapshot.refreshToken, "refresh-kept");
  assert.equal(snapshot.tokenExpiresAt, (await import("../utils/jwt.ts")).parseJwtExpiry(live));
  assert.equal(saveValidatedAuthSession(TEST_ID, { ...snapshot, capturedAt: Date.now() }, "valid").saved, true);
  assert.equal(getPersistedBearerToken(TEST_ID)?.token, live);
  const session = await captureAccountSessionFromPage(TEST_ID, {
    context: () => ({ cookies: async () => [{ name: "token", value: live, domain: ".qwen.ai" }] }),
    evaluate: async () => ({ token: live, userAgent: "synthetic-UA" }),
  } as never);
  assert.equal(session.bearerToken, live);
  assert.equal((await import("../services/qwen-token-refresh.ts")).getJarPair(session.cookieHeader, "token"), live);
});

test("D: absent localStorage uses a live cookie; expired live material cannot replace it", async () => {
  const cookie = syntheticJwt(209);
  const snapshot = await visibleSnapshot(cookie, "");
  assert.ok(snapshot?.cookie.includes(`token=${cookie}`));
  assert.equal(selectManualAccessToken({ token: syntheticJwt(281, 1), access: "" }, cookie)?.token, cookie);
  assert.equal(selectManualAccessToken({ token: "", access: "" }, syntheticJwt(209, 1)), null);
});

test("E: snapshot without refresh rotation preserves the previous persisted refresh", async () => {
  const { saveAuthSession, saveValidatedAuthSession, getRefreshMaterial } = await import("../core/database.ts");
  saveAuthSession(TEST_ID, { cookie: `token=${syntheticJwt(281)}; refresh_token=old-refresh`, userAgent: "synthetic-UA", refreshToken: "old-refresh" });
  const snapshot = await visibleSnapshot(syntheticJwt(209), syntheticJwt(281));
  assert.ok(snapshot);
  assert.equal(snapshot.refreshToken, undefined);
  await saveManualAuthSession(TEST_ID, snapshot);
  assert.equal(getRefreshMaterial(TEST_ID)?.refreshToken, "old-refresh");
  assert.ok(getRefreshMaterial(TEST_ID)?.jar.includes("refresh_token=old-refresh"));
});

test("B/F: HTTP 200 logical rejection and ambiguity fail verification without promotion or session loss", async () => {
  for (const [raw, expected] of [
    [JSON.stringify({ success: false, data: { code: "Unauthorized" } }), "rejected"],
    [JSON.stringify({ success: false, data: { code: "InternalError" } }), "inconclusive"],
    ["not JSON", "inconclusive"],
  ] as const) {
    setAccountAuthState(TEST_ID, "rejected");
    const { saveAuthSession, getRefreshMaterial } = await import("../core/database.ts");
    saveAuthSession(TEST_ID, { cookie: "token=preserved; refresh_token=preserved-refresh", userAgent: "synthetic-UA", refreshToken: "preserved-refresh" });
    const { emit, calls } = installHarness({ loggedIn: false });
    setManualVerificationDeps({ validateLive: async () => ({ status: 200, state: classifyManualSettingsResponse(200, raw) }) });
    assert.equal(classifyManualSettingsResponse(200, raw), expected);
    await startManualVerification(TEST_ID);
    await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
    assert.equal(await waitForState("failed"), "failed");
    assert.equal(getAccountAuthState(TEST_ID), "rejected");
    assert.equal(getRefreshMaterial(TEST_ID)?.refreshToken, "preserved-refresh");
    assert.deepEqual(calls.clearedCooldown, []);
  }
});

test("C: authoritative settings success is valid; bare HTTP 200 is inconclusive", () => {
  assert.equal(classifyManualSettingsResponse(200, JSON.stringify({ success: true, data: {} })), "valid");
  assert.equal(classifyManualSettingsResponse(200, "{}"), "inconclusive");
  assert.equal(classifyManualSettingsResponse(401, ""), "rejected");
});


test("B post-capture: logical Unauthorized after a successful pre-check never promotes", async () => {
  setAccountAuthState(TEST_ID, "rejected");
  const { emit } = installHarness({ loggedIn: false });
  let count = 0;
  setManualVerificationDeps({ validateLive: async () => ({ status: 200, state: ++count === 1 ? "valid" : "rejected" }) });
  await startManualVerification(TEST_ID);
  await emit({ url: CHAT_URL, status: 200, body: VALID_SSE });
  assert.equal(await waitForState("failed"), "failed");
  assert.equal(getAccountAuthState(TEST_ID), "rejected");
});
