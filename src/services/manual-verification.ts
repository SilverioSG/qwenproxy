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
  | "autofilling"
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
// A persisted row only counts as fresh if written by this flow just now.
const PERSIST_FRESH_WINDOW_MS = 30000;

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
  capture: (
    accountId: string,
    opts?: { persistSession?: boolean },
  ) => Promise<void>;
  clearCooldown: (accountId: string) => Promise<void>;
  unmarkReady: (accountId: string) => Promise<void>;
  readPersistedMeta: (
    accountId: string,
  ) => Promise<{ exists: boolean; capturedAt: number }>;
  snapshotVisible: (
    page: Page,
    context: BrowserContext,
  ) => Promise<{
    cookie: string;
    userAgent: string;
    bxV?: string;
    bxUa?: string;
    bxUmidtoken?: string;
    secChUa?: string;
    secChUaMobile?: string;
    secChUaPlatform?: string;
    version?: string;
    tokenExpiresAt?: number;
  } | null>;
  saveSession: (
    accountId: string,
    session: {
      cookie: string;
      userAgent: string;
      bxV?: string;
      bxUa?: string;
      bxUmidtoken?: string;
      secChUa?: string;
      secChUaMobile?: string;
      secChUaPlatform?: string;
      version?: string;
      tokenExpiresAt?: number;
    },
  ) => Promise<void>;
  validateLive: (accountId: string) => Promise<{ status: number }>;
  probeSameContext: (page: Page) => Promise<{
    settingsStatus: number;
    settingsAppAuthFailure: boolean;
    createChatStatus: number;
    createChatSuccess: boolean;
    createChatAppAuthFailure: boolean;
    liveTokenPresent: boolean;
    cookieCount: number;
    cookieNameHash: string;
  } | null>;
  getCredentials: (
    accountId: string,
  ) => Promise<{ email: string; password: string } | null>;
  autofill: (
    page: Page,
    email: string,
    password: string,
  ) => Promise<{
    submitted: boolean;
    alreadyLoggedIn: boolean;
    reason: string;
  }>;
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
  capture: async (accountId: string, opts?: { persistSession?: boolean }) => {
    const { captureQwenHeaders } = await import("./playwright.ts");
    await captureQwenHeaders(accountId, undefined, undefined, undefined, opts ?? {});
  },
  clearCooldown: async (accountId: string) => {
    const { clearAccountCooldown } = await import("../core/account-manager.ts");
    clearAccountCooldown(accountId);
  },
  unmarkReady: async (accountId: string) => {
    const { unmarkAccountHeadersReady } = await import(
      "../core/account-manager.ts"
    );
    unmarkAccountHeadersReady(accountId);
  },
  readPersistedMeta: async (accountId: string) => {
    // Metadata only: existence + captured_at. Never cookies or tokens.
    const { getDatabase } = await import("../core/database.ts");
    const row = getDatabase()
      .prepare(
        "SELECT captured_at FROM qwen_auth_sessions WHERE account_id = ?",
      )
      .get(accountId) as { captured_at?: unknown } | undefined;
    const capturedAt = Number(row?.captured_at) || 0;
    return { exists: capturedAt > 0, capturedAt };
  },
  snapshotVisible: async (page: Page, context: BrowserContext) => {
    // Fresh material from the context that just proved a real chat. Values
    // stay in memory and go straight to saveAuthSession; only names/counts
    // are ever logged by callers (which log nothing here at all).
    const cookies: Array<{ name: string; value: string }> =
      await context.cookies();
    if (cookies.length === 0) return null;
    const byName = new Map(cookies.map((c) => [c.name, c.value]));
    if (!byName.get("token")) return null;
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    let userAgent = "";
    try {
      userAgent = await page.evaluate(() => navigator.userAgent);
    } catch {
      userAgent = "";
    }
    let secChUa: string | undefined;
    let secChUaMobile: string | undefined;
    let secChUaPlatform: string | undefined;
    try {
      const hints = await page.evaluate(() => {
        const ud = (navigator as unknown as { userAgentData?: unknown }).userAgentData as
          | {
              brands?: Array<{ brand: string; version: string }>;
              mobile?: boolean;
              platform?: string;
            }
          | undefined;
        if (!ud || !Array.isArray(ud.brands)) return null;
        return {
          secChUa: ud.brands
            .map((b) => `"${b.brand}";v="${b.version}"`)
            .join(", "),
          secChUaMobile: ud.mobile ? "?1" : "?0",
          secChUaPlatform: ud.platform ? `"${ud.platform}"` : undefined,
        };
      });
      secChUa = hints?.secChUa;
      secChUaMobile = hints?.secChUaMobile;
      secChUaPlatform = hints?.secChUaPlatform;
    } catch {
      // Client hints are optional; restore tolerates their absence.
    }
    let version: string | undefined;
    try {
      const { getQwenWebVersion } = await import("./qwen-headers.ts");
      version = getQwenWebVersion() || undefined;
    } catch {
      version = undefined;
    }
    let tokenExpiresAt: number | undefined;
    try {
      const { parseJwtExpiry } = await import("../utils/jwt.ts");
      tokenExpiresAt = parseJwtExpiry(cookie) || undefined;
    } catch {
      tokenExpiresAt = undefined;
    }
    return {
      cookie,
      userAgent,
      bxV: byName.get("bx-v") || "2.5.37",
      bxUa: byName.get("bx-ua") || "",
      bxUmidtoken: byName.get("bx-umidtoken") || "",
      secChUa,
      secChUaMobile,
      secChUaPlatform,
      version,
      tokenExpiresAt,
    };
  },
  saveSession: async (accountId, session) => {
    const { saveAuthSession } = await import("../core/database.ts");
    saveAuthSession(accountId, { ...session, capturedAt: Date.now() });
  },
  validateLive: async (accountId: string) => {
    // Authoritative check against the OPERATIONAL (headless) context: the
    // same browser transport production will use. Status only, no bodies.
    const { getBasicHeaders } = await import("./playwright.ts");
    const {
      buildCapturedQwenHeaders,
      requestQwenTextInBrowser,
    } = await import("./qwen.ts");
    const { qwenUrl } = await import("./qwen-url.ts");
    const basic = await getBasicHeaders(accountId);
    const headers = buildCapturedQwenHeaders(
      {
        cookie: basic.cookie,
        "user-agent": basic.userAgent,
        "bx-v": basic.bxV,
        "bx-ua": basic.bxUa,
        "bx-umidtoken": basic.bxUmidtoken,
      },
      { referer: qwenUrl("/settings/personalization") },
    );
    const res = await requestQwenTextInBrowser(
      accountId,
      "GET",
      "/api/v2/users/user/settings",
      headers,
      undefined,
      { referrer: qwenUrl("/settings/personalization") },
    );
    return { status: res.status };
  },
  probeSameContext: async (page: Page) => {
    // Diagnostic only: same visible page/context that just proved a real
    // chat. Cookie-only, no Authorization, no heal, single attempt each.
    // Returns structural metadata + booleans; never bodies or secrets.
    // NOTE: inline statements only (no nested arrows — __name constraints).
    try {
      const out = await page.evaluate(async (): Promise<{
        settingsStatus: number;
        settingsAppAuthFailure: boolean;
        createChatStatus: number;
        createChatSuccess: boolean;
        createChatAppAuthFailure: boolean;
        liveTokenPresent: boolean;
        cookieCount: number;
        cookieNameHash: string;
      } | null> => {
        try {
          let liveTokenPresent = false;
          try {
            const t = localStorage.getItem("token");
            liveTokenPresent = typeof t === "string" && t.length > 0;
          } catch {
            liveTokenPresent = false;
          }
          const baseHeaders: Record<string, string> = {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            "x-request-id":
              Math.random().toString(36).slice(2) +
              Math.random().toString(36).slice(2),
            source: "web",
          };
          const settingsRes = await fetch(
            "https://chat.qwen.ai/api/v2/users/user/settings",
            {
              method: "GET",
              credentials: "include",
              headers: baseHeaders,
              signal: AbortSignal.timeout(20000),
            },
          );
          const settingsText = await settingsRes.text().catch(() => "");
          let settingsAppAuthFailure = false;
          try {
            const parsed: any = JSON.parse(settingsText);
            settingsAppAuthFailure =
              parsed &&
              parsed.success === false &&
              (parsed.data?.code === "Unauthorized" ||
                parsed.code === "Unauthorized");
          } catch {
            settingsAppAuthFailure = false;
          }
          const newBody = JSON.stringify({
            chatId: "",
            models: ["qwen3.8-max"],
            project_id: "",
            timestamp: Date.now(),
          });
          const createRes = await fetch(
            "https://chat.qwen.ai/api/v2/chats/new",
            {
              method: "POST",
              credentials: "include",
              headers: baseHeaders,
              body: newBody,
              signal: AbortSignal.timeout(30000),
            },
          );
          const createText = await createRes.text().catch(() => "");
          let createChatSuccess = false;
          let createChatAppAuthFailure = false;
          try {
            const cparsed: any = JSON.parse(createText);
            if (cparsed && typeof cparsed === "object") {
              createChatSuccess = Boolean(
                cparsed.chat_id ||
                  cparsed.id ||
                  cparsed.data?.chat_id ||
                  cparsed.data?.id ||
                  cparsed.data?.chat?.id,
              );
              createChatAppAuthFailure =
                cparsed.success === false &&
                (cparsed.data?.code === "Unauthorized" ||
                  cparsed.code === "Unauthorized");
            }
          } catch {
            createChatSuccess = false;
            createChatAppAuthFailure = false;
          }
          let cookieCount = 0;
          let cookieNameHash = "";
          try {
            const rawParts = document.cookie.split(";");
            const names: string[] = [];
            for (let i = 0; i < rawParts.length; i++) {
              const trimmed = rawParts[i].trim();
              if (!trimmed) continue;
              cookieCount += 1;
              const eq = trimmed.indexOf("=");
              names.push(eq >= 0 ? trimmed.slice(0, eq) : trimmed);
            }
            names.sort();
            let joined = "";
            for (let i = 0; i < names.length; i++) {
              joined += (i > 0 ? ";" : "") + names[i];
            }
            let h1 = 0x811c9dc5;
            for (let i = 0; i < joined.length; i++) {
              h1 ^= joined.charCodeAt(i);
              h1 = Math.imul(h1, 0x01000193);
            }
            cookieNameHash = (h1 >>> 0).toString(16);
          } catch {
            cookieCount = 0;
            cookieNameHash = "";
          }
          return {
            settingsStatus: settingsRes.status,
            settingsAppAuthFailure,
            createChatStatus: createRes.status,
            createChatSuccess,
            createChatAppAuthFailure,
            liveTokenPresent,
            cookieCount,
            cookieNameHash,
          };
        } catch {
          return null;
        }
      });
      return out;
    } catch {
      return null;
    }
  },
  getCredentials: async (accountId: string) => {
    // Backend-only: values never leave this process (no frontend payload).
    const { getAccountCredentials } = await import("../core/accounts.ts");
    const creds = getAccountCredentials(accountId);
    if (!creds?.email || !creds?.password) return null;
    return { email: creds.email, password: creds.password };
  },
  autofill: async (page: Page, email: string, password: string) => {
    const { autofillQwenLoginForm } = await import("./playwright.ts");
    return autofillQwenLoginForm(page, email, password);
  },
};

/** Redact IDs from an API pathname for safe discovery logging. */
export function redactApiPathname(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    const q = path.indexOf("?");
    if (q >= 0) path = path.slice(0, q);
  }
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{4,}/gi, "<id>")
    .replace(/\b\d{5,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>");
}
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
    // Hygiene: a stale row must never surface as Ready during this flow.
    // Ready is re-earned only through the gated success path below.
    await deps.unmarkReady(accountId).catch(() => {});

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

    // Backend-only autofill (QwenGate concept, no password to frontend):
    // if the profile is not logged in and we hold stored credentials, fill
    // and submit the form, then leave CAPTCHA/slider to the user by hand.
    setStatus(entry, "autofilling", "Checking session and credentials");
    try {
      const creds = await deps.getCredentials(accountId);
      if (!creds) {
        finish("failed", "No stored credentials for account");
        return;
      }
      const auto = await deps.autofill(page, creds.email, creds.password);
      if (auto.reason === "submitted") {
        setStatus(
          entry,
          "waiting",
          "Credentials submitted — complete Qwen verification manually",
        );
      } else if (!auto.alreadyLoggedIn && auto.reason === "no-form") {
        finish("failed", "Login form not found");
        return;
      } else if (!auto.alreadyLoggedIn && auto.reason === "challenge-wall") {
        setStatus(
          entry,
          "waiting",
          "Verification challenge detected — solve it manually",
        );
      }
      // already-logged-in / no-password-field / submit-failed: keep the
      // window open and let the user continue manually.
    } catch {
      // Autofill is best-effort; manual completion remains possible.
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
    let pendingSnapshot: {
      at: number;
      session: NonNullable<
        Awaited<ReturnType<typeof deps.snapshotVisible>>
      >;
    } | null = null;
    const onResponse: ChatResponseListener = (res) => {
      // Synchronous header part only: url/method/status. Never blocks.
      let status = 0;
      try {
        if (entry.finished) return;
        const url = typeof res.url === "function" ? res.url() : "";
        if (!url.includes(CHAT_COMPLETIONS_PATH)) {
          // Discovery: which /api/v2 endpoints does the real UI actually
          // hit? Pathnames only, IDs redacted, no bodies/values.
          try {
            if (url.includes("/api/v2/")) {
              const method =
                typeof res.request === "function"
                  ? res.request().method?.() ?? ""
                  : "";
              if (method === "POST") {
                logEvent(
                  entry,
                  accountId,
                  `api-path=${redactApiPathname(url)}`,
                );
              }
            }
          } catch {
            // Discovery must never break verification.
          }
          return;
        }
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
        // Opportunistic snapshot at streaming time: cookies are stable once
        // the challenge is solved and the send is accepted. Memory-only,
        // never logged; lets the grace path persist genuinely fresh material
        // even if the window closes before done-classification.
        void (async () => {
          try {
            if (entry.finished || context === null) return;
            const s = await deps.snapshotVisible(page, context);
            if (s) pendingSnapshot = { at: Date.now(), session: s };
          } catch {
            // Best-effort; the gated path re-checks freshness.
          }
        })();
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
    const attachedPages = new Set<unknown>();
    const attachToPage = (p: unknown): void => {      try {
        if (!p || attachedPages.has(p)) return;
        attachedPages.add(p);
        (p as { on?: (ev: string, fn: unknown) => void }).on?.(
          "response",
          onResponse,
        );
      } catch {
        // Best effort per page.
      }
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
      try {
        const c: unknown = context;
        if (!c) return;
        const pages: unknown[] =
          typeof (c as { pages?: unknown }).pages === "function"
            ? (c as { pages: () => unknown[] }).pages()
            : [];
        for (const p of pages) {
          try {
            (p as { removeListener?: (ev: string, fn: unknown) => void }).removeListener?.(
              "response",
              onResponse,
            );
          } catch {
            continue;
          }
        }
      } catch {
        // Best effort.
      }
    };
    try {
      // Attach to every page in the visible context (restored profiles may
      // hold background tabs; the user may chat in any of them) plus future
      // pages opened during the flow.
      if (context === null) throw new Error("no visible context");
      const pages: unknown[] =
        typeof context.pages === "function" ? context.pages() : [page];
      for (const p of pages) attachToPage(p);
      const ctxWithOn = context as unknown as {
        on?: (ev: string, fn: (p: unknown) => void) => void;
      };
      ctxWithOn.on?.("page", (p: unknown) => attachToPage(p));
    } catch {
      // If listeners are unsupported, chat evidence can never arrive and the
      // flow ends in timeout rather than false success.
    }

    // Main wait: login is INFORMATIONAL ONLY (hint for the user, never a
    // gate). Only a real chat completion (evidence() === "done") can
    // trigger success. The window stays open through login, popups and
    // slider solving; the user sends a test message by hand. Preserve a
    // challenge-wall detail set by autofill.
    if (!/challenge/i.test(entry.detail ?? "")) {
      setStatus(
        entry,
        "waiting",
        "Waiting — send a test message in Qwen",
      );
    } else {
      setStatus(entry, "waiting", entry.detail);
    }
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
      if (!(await completeSuccess(entry, accountId, { page, context }, pendingSnapshot))) return;
      context = null;
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
          // Visible context already closed: fall back to the opportunistic
          // snapshot taken while it was open (fresh by construction).
          if (!(await completeSuccess(entry, accountId, null, pendingSnapshot))) return;
          context = null;
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
 * Shared success path. verified requires ALL of:
 * 1. real manual chat completion observed (caller guarantees chatEvidence);
 * 2. fresh auth snapshot persisted from the validated visible context;
 * 3. DB captured_at actually advanced within a tight window;
 * 4. live validation (authoritative settings check on the operational
 *    headless context) returns 200;
 * 5. only then cooldown cleared.
 * Anything else ends failed. Never marks Ready on stale material.
 */
async function completeSuccess(
  entry: ActiveVerification,
  accountId: string,
  visible: { page: Page; context: BrowserContext } | null,
  pending: {
    at: number;
    session: NonNullable<Awaited<ReturnType<typeof deps.snapshotVisible>>>;
  } | null,
): Promise<boolean> {
  const { traceLsCheckpoint } = await import("./session-tracer.ts");
  void traceLsCheckpoint(accountId, "manual-verify-success-start").catch(() => {});
  const before = await deps.readPersistedMeta(accountId).catch(() => ({
    exists: false,
    capturedAt: 0,
  }));
  logEvent(
    entry,
    accountId,
    `persist before capturedAt=${before.capturedAt} ageMs=${before.exists ? Date.now() - before.capturedAt : -1}`,
  );
  // 1b. Same-context diagnostic probe (observational only — never gates):
  // run the transport-equivalent settings + chats/new against the SAME
  // visible page before anything is closed, snapshotted, or recreated.
  if (visible) {
    try {
      const probe = await deps.probeSameContext(visible.page);
      if (probe) {
        logEvent(
          entry,
          accountId,
          `same-context settings=${probe.settingsStatus} settingsAppFail=${probe.settingsAppAuthFailure} ` +
            `create=${probe.createChatStatus} createOk=${probe.createChatSuccess} ` +
            `createAppFail=${probe.createChatAppAuthFailure} liveToken=${probe.liveTokenPresent} ` +
            `cookies=${probe.cookieCount} cookieNames=${probe.cookieNameHash}`,
        );
      } else {
        logEvent(entry, accountId, "same-context probe inconclusive");
      }
    } catch {
      logEvent(entry, accountId, "same-context probe error");
    }
  }
  // 2. Fresh snapshot from the context that proved the real chat — BEFORE
  // closing it, and BEFORE headless init can restore the old row. Grace
  // path (visible already closed): fall back to the opportunistic snapshot
  // taken while it was open.
  let snapshot: Awaited<ReturnType<typeof deps.snapshotVisible>> = null;
  if (visible) {
    try {
      snapshot = await deps.snapshotVisible(visible.page, visible.context);
    } catch (err) {
      finishOnEntry(
        entry,
        "failed",
        `Visible session snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  } else if (pending) {
    snapshot = pending.session;
  }
  if (!snapshot) {
    finishOnEntry(
      entry,
      "failed",
      "Visible session has no usable auth cookies",
    );
    return false;
  }
  try {
    await deps.saveSession(accountId, snapshot);
  } catch (err) {
    // A failed persist must NEVER become verified (previously silent).
    logEvent(entry, accountId, "auth-persist failed");
    finishOnEntry(
      entry,
      "failed",
      `Auth persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  // 3. Verify the row actually advanced (catches silent persist failures).
  const after = await deps.readPersistedMeta(accountId).catch(() => ({
    exists: false,
    capturedAt: 0,
  }));
  const fresh =
    after.exists &&
    after.capturedAt > before.capturedAt &&
    Date.now() - after.capturedAt <= PERSIST_FRESH_WINDOW_MS;
  logEvent(
    entry,
    accountId,
    `persist after capturedAt=${after.capturedAt} fresh=${fresh}`,
  );
  if (!fresh) {
    finishOnEntry(
      entry,
      "failed",
      "Persisted session is not fresh after snapshot",
    );
    return false;
  }
  // Only now release the visible window: the fresh row is already durable,
  // so headless init restores the NEW auth instead of the old one.
  if (visible) {
    await closeVisible(entry, visible.context);
  }
  try {
    await deps.initHeadless(await deps.fullAccount(accountId));
  } catch {
    // initHeadless is best-effort; live validation below decides.
  }
  // 4. PRE-CAPTURE live validation on the operational context.
  let liveStatus = 0;
  try {
    liveStatus = (await deps.validateLive(accountId)).status;
  } catch {
    liveStatus = 0;
  }
  logEvent(entry, accountId, `pre-capture settings status=${liveStatus}`);
  if (liveStatus !== 200) {
    finishOnEntry(
      entry,
      "failed",
      `Pre-capture live validation failed (settings ${liveStatus})`,
    );
    return false;
  }
  // 5. Final capture refreshes RUNTIME cache only: persistSession=false, so
  // the fresh visible row can never be overwritten here.
  const rowBeforeCapture = await deps.readPersistedMeta(accountId).catch(() => ({
    exists: false,
    capturedAt: 0,
  }));
  try {
    await deps.capture(accountId, { persistSession: false });
  } catch (err) {
    finishOnEntry(
      entry,
      "failed",
      `Header capture after verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  const rowAfterCapture = await deps.readPersistedMeta(accountId).catch(() => ({
    exists: false,
    capturedAt: 0,
  }));
  const rowUnchanged =
    rowAfterCapture.exists &&
    rowAfterCapture.capturedAt === rowBeforeCapture.capturedAt;
  logEvent(
    entry,
    accountId,
    `final-capture db-write=${!rowUnchanged} rowUnchanged=${rowUnchanged}`,
  );
  if (!rowUnchanged) {
    // Defensive: the durable visible row must survive the final capture.
    // Reset the headless context so the next init restores the fresh row.
    try {
      await deps.closeHeadless(accountId);
    } catch {
      // Best effort.
    }
    finishOnEntry(
      entry,
      "failed",
      "Final capture modified the persisted session",
    );
    return false;
  }
  // 6. POST-CAPTURE live validation on the exact post-capture context.
  let postStatus = 0;
  try {
    postStatus = (await deps.validateLive(accountId)).status;
  } catch {
    postStatus = 0;
  }
  logEvent(entry, accountId, `post-capture settings status=${postStatus}`);
  if (postStatus !== 200) {
    try {
      await deps.closeHeadless(accountId);
    } catch {
      // Best effort: quarantine the possibly contaminated context.
    }
    finishOnEntry(
      entry,
      "failed",
      `Post-capture live validation failed (settings ${postStatus})`,
    );
    return false;
  }
  // 7. Cooldown cleared ONLY after validated fresh auth.
  await deps.clearCooldown(accountId);
  void traceLsCheckpoint(accountId, "manual-verify-success-end").catch(() => {});
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
