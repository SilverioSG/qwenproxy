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
}

const activeVerifications = new Map<string, ActiveVerification>();

const POLL_INTERVAL_MS = 2500;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const PROFILE_LOCK_WAIT_MS = 15000;

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
  isPageLoggedIn: (page: Page, timeoutMs: number) => Promise<boolean>;
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
  isPageLoggedIn: async () => false,
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
  context: BrowserContext | null,
): Promise<void> {
  if (!context) return;
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
    entry.finished = true;
    setStatus(entry, state, detail);
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

    setStatus(entry, "waiting", "Waiting for manual login in the visible window");
    const deadline = now() + VERIFY_TIMEOUT_MS;
    let verified = false;
    while (now() < deadline) {
      if (entry.cancelRequested) {
        finish("cancelled", "Cancelled by user");
        return;
      }
      let closed = false;
      try {
        closed =
          typeof page.isClosed === "function"
            ? page.isClosed()
            : context === null;
      } catch {
        closed = true;
      }
      if (closed || context === null) {
        finish("cancelled", "Browser closed before verification");
        return;
      }
      try {
        if (await deps.isPageLoggedIn(page, 5000)) {
          verified = true;
          break;
        }
      } catch {
        // Transient probe failure: keep waiting until timeout/close.
      }
      await deps.sleep(POLL_INTERVAL_MS);
    }
    if (!verified) {
      finish("failed", "Verification timeout (10 min) without valid session");
      return;
    }

    setStatus(entry, "verifying", "Capturing session");
    await closeVisible(context);
    context = null;
    await deps.initHeadless(await deps.fullAccount(accountId));
    try {
      await deps.capture(accountId);
    } catch (err) {
      finish(
        "failed",
        `Header capture after verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await deps.clearCooldown(accountId);
    finish("verified", "Session validated, persisted, cooldown cleared");
  } catch (err) {
    finish(
      "failed",
      `Manual verification error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closeVisible(context);
    try {
      await deps.clearBusy(accountId);
    } catch {
      // Never leave the caller hanging on cleanup failure.
    }
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
