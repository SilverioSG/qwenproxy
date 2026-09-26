/**
 * Manual per-account verification ("Verify manually").
 *
 * Opens a VISIBLE Chromium on the account's own persistent profile so the
 * user can solve login/CAPTCHA/slider by hand. Validation and persistence
 * reuse the canonical v1.4.0 architecture (isPageLoggedIn,
 * captureQwenHeaders → saveAuthSession, clearAccountCooldown only on
 * success). No automation of challenges, no password to the frontend.
 *
 * Lifecycle B: controlled close of the account's headless browser, headed
 * launch on the same userDataDir, poll, close, headless re-inits on demand.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";

export type ManualVerificationState =
  | "opening"
  | "waiting"
  | "authenticated"
  | "verifying"
  | "verified"
  | "failed"
  | "cancelled"
  | "busy";

export interface ManualVerificationStatus {
  accountId: string;
  state: ManualVerificationState;
  startedAt: number;
  updatedAt: number;
  detail?: string;
}

interface ActiveVerification extends ManualVerificationStatus {
  cancelRequested: boolean;
  finished: boolean;
  /** Set once login is authoritatively confirmed: terminal states become
   *  monotonic (verified > cancelled) and programmatic closes are expected. */
  finalizing: boolean;
  /** Set before closes executed by this flow: never interpret as user cancel. */
  expectedClose: boolean;
}

const activeVerifications = new Map<string, ActiveVerification>();

const POLL_INTERVAL_MS = 2500;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const PROFILE_LOCK_WAIT_MS = 15000;
const CLOSE_GRACE_MS = 4000;

const HEADED_CHROME_PATH =
  "/home/silver/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

function now(): number {
  return Date.now();
}

function setStatus(
  entry: ActiveVerification,
  state: ManualVerificationState,
  detail?: string,
): void {
  entry.state = state;
  entry.updatedAt = now();
  if (detail !== undefined) entry.detail = detail;
}

/** Injectable browser launcher (tests replace this; no real Chromium). */
type BrowserLauncher = (
  profileDir: string,
  env: Record<string, string>,
) => Promise<{ context: BrowserContext; page: Page }>;

type ChatResponseListener = (res: {
  url: () => string;
  ok: () => boolean;
  status: () => number;
  text: () => Promise<string>;
  request: () => { method: () => string };
}) => void;

/**
 * Pure success predicate for an observed chat completion response.
 * Evidence only: returns a boolean, never stores or logs message content.
 */
export function isValidChatCompletion(
  status: number,
  bodyText: string,
): boolean {
  if (!(status >= 200 && status < 300)) return false;
  if (typeof bodyText !== "string" || bodyText.length === 0) return false;
  return bodyText.includes("[DONE]") || bodyText.includes('"choices"');
}

const CHAT_COMPLETIONS_PATH = "/api/v2/chat/completions";

async function defaultBrowserLauncher(
  profileDir: string,
  env: Record<string, string>,
): Promise<{ context: BrowserContext; page: Page }> {
  const { buildChromiumLaunchArgs } = await import("./playwright.ts");
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: HEADED_CHROME_PATH,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: buildChromiumLaunchArgs({ width: 1280, height: 800 }),
    env: { ...process.env as Record<string, string>, ...env },
  });
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

interface AccountRef {
  id: string;
  email: string;
}

const deps: {
  launchBrowser: BrowserLauncher;
  probeLogin: (
    page: Page,
    timeoutMs: number,
  ) => Promise<{ ok: boolean; reason: string }>;
  sleep: (ms: number) => Promise<void>;
  headedChromeExists: () => boolean;
  singletonLocked: (profileDir: string) => boolean;
  findAccount: (accountId: string) => Promise<AccountRef | undefined>;
  fullAccount: (accountId: string) => Promise<never>;
  activeStreams: (accountId: string) => Promise<number>;
  accountBusy: (accountId: string) => Promise<boolean>;
  markBusy: (accountId: string) => Promise<void>;
  clearBusy: (accountId: string) => Promise<void>;
  profileDir: (accountId: string) => Promise<string>;
  closeHeadless: (accountId: string) => Promise<void>;
  initHeadless: (account: never) => Promise<void>;
  capture: (accountId: string) => Promise<void>;
  clearCooldown: (accountId: string) => Promise<void>;
} = {
  launchBrowser: defaultBrowserLauncher,
  probeLogin: async (page: Page, timeoutMs: number) => {
    const { probePageLoggedIn } = await import("./playwright.ts");
    return probePageLoggedIn(page, timeoutMs);
  },
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  headedChromeExists: () => fs.existsSync(HEADED_CHROME_PATH),
  singletonLocked: (profileDir: string) => singletonLockPresent(profileDir),
  findAccount: async (accountId: string) => {
    const { loadAccounts } = await import("../core/accounts.ts");
    const a = loadAccounts().find((x) => x.id === accountId);
    return a ? { id: a.id, email: a.email } : undefined;
  },
  fullAccount: async (accountId: string) => {
    const { loadAccounts } = await import("../core/accounts.ts");
    const a = loadAccounts().find((x) => x.id === accountId);
    if (!a) throw new Error("Account not found");
    return a as never;
  },
  activeStreams: async (accountId: string) => {
    const { getAccountConcurrencySnapshot } = await import(
      "../core/account-concurrency.ts"
    );
    return (
      getAccountConcurrencySnapshot().find((s) => s.accountId === accountId)
        ?.active ?? 0
    );
  },
  accountBusy: async (accountId: string) => {
    const { isAccountBusy } = await import("../core/account-concurrency.ts");
    return isAccountBusy(accountId);
  },
  markBusy: async (accountId: string) => {
    const { markAccountTemporarilyBusy } = await import(
      "../core/account-concurrency.ts"
    );
    markAccountTemporarilyBusy(accountId, VERIFY_TIMEOUT_MS + 120000);
  },
  clearBusy: async (accountId: string) => {
    const { clearTemporaryBusy } = await import(
      "../core/account-concurrency.ts"
    );
    clearTemporaryBusy(accountId);
  },
  profileDir: async (accountId: string) => {
    const { getAccountProfilePath } = await import("../core/paths.ts");
    return getAccountProfilePath(accountId);
  },
  closeHeadless: async (accountId: string) => {
    const { closePlaywrightForAccount } = await import("./playwright.ts");
    await closePlaywrightForAccount(accountId).catch(() => {});
  },
  initHeadless: async (account: never) => {
    const { initPlaywrightForAccount } = await import("./playwright.ts");
    await initPlaywrightForAccount(account, true, "chromium", {
      skipHeaderCapture: false,
    }).catch(() => {});
  },
  capture: async (accountId: string) => {
    const { captureQwenHeaders } = await import("./playwright.ts");
    await captureQwenHeaders(accountId);
  },
  clearCooldown: async (accountId: string) => {
    const { clearAccountCooldown } = await import("../core/account-manager.ts");
    clearAccountCooldown(accountId);
  },
};

/** Test hook: replace browser launch / validation / sleep. */
export function setManualVerificationDeps(
  overrides: Partial<typeof deps>,
): void {
  Object.assign(deps, overrides);
}

export function getManualVerificationStatus(
  accountId: string,
): ManualVerificationStatus | null {
  const entry = activeVerifications.get(accountId);
  if (!entry) return null;
  const { cancelRequested: _c, finished: _f, ...status } = entry;
  return status;
}

/**
 * Resolve DISPLAY/XAUTHORITY for the visible browser.
 * Never invents paths: every candidate must exist and be non-empty.
 */
export function resolveManualDisplay():
  | { display: string; xauthority: string }
  | { error: string } {
  const display = process.env.DISPLAY || ":0.0";
  const candidates: string[] = [];
  if (process.env.XAUTHORITY) candidates.push(process.env.XAUTHORITY);
  const home = process.env.HOME || "/home/silver";
  candidates.push(path.join(home, ".Xauthority"));
  try {
    const tmp = fs.readdirSync("/tmp").filter((f) => f.startsWith("xauth_"));
    const me = typeof process.getuid === "function" ? process.getuid() : -1;
    const withStat: Array<{ p: string; mtime: number }> = [];
    for (const f of tmp) {
      const p = path.join("/tmp", f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size > 0 && (me < 0 || st.uid === me)) {
          withStat.push({ p, mtime: st.mtimeMs });
        }
      } catch {
        continue;
      }
    }
    withStat.sort((a, b) => b.mtime - a.mtime);
    for (const c of withStat) candidates.push(c.p);
  } catch {
    // /tmp unreadable: fall through to explicit candidates only.
  }
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) {
        return { display, xauthority: candidate };
      }
    } catch {
      continue;
    }
  }
  return {
    error:
      "No usable XAUTHORITY found (checked $XAUTHORITY, ~/.Xauthority, /tmp/xauth_*). " +
      "Start/resume the graphical session or set XAUTHORITY explicitly.",
  };
}

function logEvent(
  entry: ActiveVerification,
  accountId: string,
  event: string,
): void {
  // Bounded operational log: state machine events only. Never prompt,
  // response, cookies, tokens, or bodies.
  try {
    console.log(
      `[ManualVerify ${accountId.slice(0, 8)}] ${event} state=${entry.state}`,
    );
  } catch {
    // Logging must never break verification.
  }
}

function singletonLockPresent(profileDir: string): boolean {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.lstatSync(path.join(profileDir, name));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function closeVisible(
  entry: ActiveVerification,
  context: BrowserContext | null,
): Promise<void> {
  if (!context) return;
  entry.expectedClose = true;
  try {
    await context.close();
  } catch {
    // Best effort: profile lock release is verified separately.
  }
}

async function runVerification(accountId: string): Promise<void> {
  const entry = activeVerifications.get(accountId);
  if (!entry || entry.finished) return;

  let context: BrowserContext | null = null;
  const finish = (
    state: ManualVerificationState,
    detail?: string,
  ): void => {
    // Terminal states are monotonic: once finished (notably verified),
    // no later event may downgrade the outcome.
    if (entry.finished) return;
    entry.finished = true;
    setStatus(entry, state, detail);
  };
  const markExpectedClose = (): void => {
    entry.expectedClose = true;
  };

  try {
    const account = await deps.findAccount(accountId);
    if (!account) {
      finish("failed", "Account not found");
      return;
    }
    if ((await deps.activeStreams(accountId)) > 0) {
      finish("failed", "Account has an active stream");
      return;
    }
    await deps.markBusy(accountId);

    if (!deps.headedChromeExists()) {
      finish("failed", "Headed Chromium not installed");
      return;
    }
    const display = resolveManualDisplay();
    if ("error" in display) {
      finish("failed", display.error);
      return;
    }

    setStatus(entry, "opening", "Closing headless browser");
    await deps.closeHeadless(accountId);

    const profileDir = await deps.profileDir(accountId);
    const lockDeadline = now() + PROFILE_LOCK_WAIT_MS;
    while (deps.singletonLocked(profileDir) && now() < lockDeadline) {
      await deps.sleep(500);
    }
    if (deps.singletonLocked(profileDir)) {
      finish("failed", "Profile lock still held after headless close");
      return;
    }

    setStatus(entry, "opening", "Opening visible browser");
    const launched = await deps.launchBrowser(profileDir, {
      DISPLAY: display.display,
      XAUTHORITY: display.xauthority,
    });
    context = launched.context;
    const page = launched.page;
    try {
      await page.goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch {
      // Navigation failure surfaces as failed validation below.
    }

    // Passive completion evidence in two levels. Streaming (response headers
    // on a real chat request) means "do not conclude yet"; done (valid
    // completion body) is the only success trigger. Never abort/fulfill
    // (unlike header capture): the user's chat must flow untouched. Listener
    // installed before any login so no completion can slip through.
    // Login probing below is INFORMATIONAL ONLY: it never gates verification.
    const chat: { evidence: "none" | "streaming" | "done" } = { evidence: "none" };
    const evidence = (): "none" | "streaming" | "done" => chat.evidence;
    let pendingChatClassification = 0;
    const onResponse: ChatResponseListener = (res) => {
      // Synchronous header part only: url/method/status. Never blocks.
      let status = 0;
      try {
        if (entry.finished) return;
        const url = typeof res.url === "function" ? res.url() : "";
        if (!url.includes(CHAT_COMPLETIONS_PATH)) return;
        const method =
          typeof res.request === "function"
            ? res.request().method?.() ?? ""
            : "";
        if (method !== "" && method !== "POST") return;
        status = typeof res.status === "function" ? res.status() : 0;
        const ok =
          typeof res.ok === "function" ? res.ok() : status >= 200 && status < 300;
        if (!ok) return;
      } catch {
        return;
      }
      if (evidence() === "none") {
        chat.evidence = "streaming";
        logEvent(entry, accountId, "chat=streaming");
      }
      // Controlled body classification: tracked so close/timeout can wait
      // for it briefly instead of concluding on a pending read. Content is
      // used only for the boolean predicate — never stored or logged.
      pendingChatClassification += 1;
      const capturedStatus = status;
      void (async () => {
        try {
          const body = await res.text();
          if (
            !entry.finished &&
            isValidChatCompletion(capturedStatus, body)
          ) {
            chat.evidence = "done";
            logEvent(entry, accountId, "chat=done");
          }
        } catch {
          // A failed/interrupted read is not evidence; keep waiting.
        } finally {
          pendingChatClassification -= 1;
        }
      })();
    };
    const detachListener = (): void => {
      try {
        (page as { removeListener?: (ev: string, fn: unknown) => void }).removeListener?.(
          "response",
          onResponse,
        );
      } catch {
        // Best effort.
      }
    };
    try {
      (page as { on?: (ev: string, fn: unknown) => void }).on?.(
        "response",
        onResponse,
      );
    } catch {
      // If listeners are unsupported, chat evidence can never arrive and the
      // flow ends in timeout rather than false success.
    }

    // Main wait: login is INFORMATIONAL ONLY (hint for the user, never a
    // gate). Only a real chat completion (evidence() === "done") can
    // trigger success. The window stays open through login, popups and
    // slider solving; the user sends a test message by hand.
    setStatus(
      entry,
      "waiting",
      "Waiting — send a test message in Qwen",
    );
    const deadline = now() + VERIFY_TIMEOUT_MS;
    let poll = 0;
    let lastLoginClass = "unknown";
    let loginHint = false;
    let lastLogAt = 0;
    let sawClose = false;
    const maybeLog = (): void => {
      if (now() - lastLogAt < 10000) return;
      lastLogAt = now();
      logEvent(
        entry,
        accountId,
        `poll=${poll} state=${entry.state} login=${loginHint} class=${lastLoginClass} chat=${chat.evidence}`,
      );
    };
    while (now() < deadline) {
      poll += 1;
      if (entry.cancelRequested && !entry.finalizing) {
        detachListener();
        finish("cancelled", "Cancelled by user");
        return;
      }
      if (isClosed(page, context)) {
        if (entry.expectedClose) {
          entry.expectedClose = false;
          await deps.sleep(POLL_INTERVAL_MS);
          continue;
        }
        sawClose = true;
        break;
      }
      try {
        const probe = await deps.probeLogin(page, 5000);
        lastLoginClass = probe.reason;
        if (probe.ok && !loginHint) {
          loginHint = true;
          setStatus(
            entry,
            "authenticated",
            "Authenticated — send a test message in Qwen",
          );
        }
      } catch {
        lastLoginClass = "evaluate-error";
      }
      if (evidence() === "done") break;
      maybeLog();
      await deps.sleep(POLL_INTERVAL_MS);
    }
    detachListener();
    if (entry.finished) return;
    if (evidence() === "done") {
      entry.finalizing = true;
      setStatus(entry, "verifying", "Chat verified, capturing session");
      await closeVisible(entry, context);
      context = null;
      if (!(await completeSuccess(entry, accountId))) return;
      return;
    }
    if (sawClose) {
      if (evidence() === "streaming") {
        // Grace: a completion may still be classifying (e.g. SSE body read
        // pending when the user closed). Wait briefly for done; anything
        // else concludes cancelled — streaming alone never verifies.
        logEvent(entry, accountId, "close-grace-start");
        const graceEnd = now() + CLOSE_GRACE_MS;
        while (now() < graceEnd) {
          if (entry.finished) return;
          if (evidence() === "done") break;
          if (pendingChatClassification <= 0) break;
          await deps.sleep(250);
        }
        if (evidence() === "done" && !entry.finished) {
          logEvent(entry, accountId, "close-grace-success");
          entry.finalizing = true;
          setStatus(entry, "verifying", "Chat verified, capturing session");
          await closeVisible(entry, context);
          context = null;
          if (!(await completeSuccess(entry, accountId))) return;
          return;
        }
        logEvent(entry, accountId, "close-grace-expired");
      }
      finish("cancelled", "Browser closed before chat verification");
      return;
    }
    finish("failed", "Verification timeout (10 min) without chat completion");
    return;
  } catch (err) {
    finish(
      "failed",
      `Manual verification error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closeVisible(entry, context);
    try {
      await deps.clearBusy(accountId);
    } catch {
      // Never leave the caller hanging on cleanup failure.
    }
  }
}

/**
 * Shared success path: headless re-init on the validated profile, canonical
 * header capture (persists via saveAuthSession), cooldown cleared ONLY after
 * capture succeeds. Returns true on verified.
 */
async function completeSuccess(
  entry: ActiveVerification,
  accountId: string,
): Promise<boolean> {
  try {
    await deps.initHeadless(await deps.fullAccount(accountId));
  } catch {
    // initHeadless is best-effort; capture below revalidates anyway.
  }
  try {
    await deps.capture(accountId);
  } catch (err) {
    finishOnEntry(
      entry,
      "failed",
      `Header capture after verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  await deps.clearCooldown(accountId);
  finishOnEntry(
    entry,
    "verified",
    "Session validated, persisted, cooldown cleared",
  );
  return true;
}

function finishOnEntry(
  entry: ActiveVerification,
  state: ManualVerificationState,
  detail?: string,
): void {
  if (entry.finished) return;
  entry.finished = true;
  setStatus(entry, state, detail);
}

function isClosed(page: Page, context: BrowserContext | null): boolean {
  try {
    if (context === null) return true;
    return typeof page.isClosed === "function" ? page.isClosed() : false;
  } catch {
    return true;
  }
}

/**
 * Start a manual verification. Returns current status; exactly one active
 * verification per accountId. Throws with HTTP-like {status, message} on
 * precondition failure (mapped by the API layer).
 */
export async function startManualVerification(
  accountId: string,
): Promise<ManualVerificationStatus> {
  const existing = activeVerifications.get(accountId);
  if (existing && !existing.finished) {
    const err = new Error("Manual verification already active for account");
    (err as { status?: number }).status = 409;
    throw err;
  }
  if (existing && existing.finished) {
    activeVerifications.delete(accountId);
  }
  const exists = await deps.findAccount(accountId);
  if (!exists) {
    const err = new Error("Account not found");
    (err as { status?: number }).status = 404;
    throw err;
  }
  if ((await deps.activeStreams(accountId)) > 0 || (await deps.accountBusy(accountId))) {
    const err = new Error("Account busy (stream or operation in progress)");
    (err as { status?: number }).status = 409;
    throw err;
  }
  const entry: ActiveVerification = {
    accountId,
    state: "opening",
    startedAt: now(),
    updatedAt: now(),
    cancelRequested: false,
    finished: false,
    finalizing: false,
    expectedClose: false,
  };
  activeVerifications.set(accountId, entry);
  void runVerification(accountId).catch(() => {});
  return getManualVerificationStatus(accountId)!;
}

export function cancelManualVerification(
  accountId: string,
): ManualVerificationStatus | null {
  const entry = activeVerifications.get(accountId);
  if (!entry || entry.finished) return entry ? getManualVerificationStatus(accountId) : null;
  entry.cancelRequested = true;
  entry.updatedAt = now();
  return getManualVerificationStatus(accountId);
}
