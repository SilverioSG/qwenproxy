/**
 * Per-account session state for the DIRECT WEB TRANSPORT.
 *
 * Proven requirement (see the live validation in the integration notes): an
 * account-mode request to chat.qwen.ai succeeds from an ordinary HTTP client
 * when, and only when, it carries BOTH of these:
 *
 *   1. `Authorization: Bearer <JWT>` — the account's current token. Without it
 *      /api/v2/chats/new and /api/v2/chat/completions answer HTTP 200 JSON
 *      {"success":false,"data":{"code":"Unauthorized"}}. (The cookie alone is
 *      the *guest* credential.)
 *   2. the account's live cookie jar, which after a human solve of the official
 *      captcha contains the Aliyun clearance cookie `x5sec`. Without it the
 *      completion endpoint answers HTTP 200 JSON
 *      {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::…"],
 *       "data":{"url":"…/_____tmd_____/punish?x5secdata=…"}}.
 *
 * `x5sec` is minted ONLY by a human solving the official slider, and lives ~25
 * minutes. It is never synthesised and never renewed on a timer: the upstream
 * challenge is the only thing that triggers a new solve. It is kept here only
 * so the transport knows whether a clearance is currently held.
 *
 * SECURITY: nothing in this module ever returns a secret to a log. Diagnostics
 * carry lengths and 8-character hash prefixes only.
 */

import { createHash } from "node:crypto";
import type { Page } from "patchright";
import { config } from "../core/config.ts";

/** Name of the Aliyun WAF clearance cookie produced by a successful solve. */
export const X5SEC_COOKIE_NAME = "x5sec";

/** Re-capture the jar at most this often (it is cheap: the page is already up). */
const SESSION_TTL_MS = 60_000;

export interface AccountSessionState {
  accountId: string;
  /** Full `Cookie:` header value for chat.qwen.ai. NEVER logged. */
  cookieHeader: string;
  /** localStorage `token` — the account JWT used as `Authorization: Bearer`. NEVER logged. */
  bearerToken: string;
  userAgent: string;
  /** Aliyun clearance presence/expiry, derived from the cookie itself. */
  x5secPresent: boolean;
  /** Epoch ms at which the clearance cookie expires (0 when absent). */
  x5secExpiresAt: number;
  /**
   * Fingerprint of the CURRENT clearance value. Lets the human-solve wait tell
   * "the person solved it" (value changed / appeared) from "the stale cookie
   * is still sitting there". A hash prefix, never the value.
   */
  x5secHash: string | null;
  /** True while the clearance is present and not expired. */
  x5secValid: boolean;
  capturedAt: number;
}

const sessions = new Map<string, AccountSessionState>();

function hash8(value: string | undefined | null): string {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, 8);
}

/**
 * Parse the `x5sec` clearance out of a cookie list. Pure and exported so the
 * expiry/invalidation rules are unit-testable without a browser.
 *
 * Playwright reports `expires` in SECONDS, and -1 for a session cookie. The
 * clearance is always a real cookie with a TTL, so a non-positive expiry is
 * treated as "no usable clearance" rather than "valid forever".
 */
export function parseX5secFromCookies(
  cookies: Array<{ name: string; expires?: number; value?: string }>,
  nowMs: number = Date.now(),
): { present: boolean; expiresAt: number; valid: boolean; hash: string | null } {
  const found = cookies.find((c) => c.name === X5SEC_COOKIE_NAME);
  if (!found) return { present: false, expiresAt: 0, valid: false, hash: null };
  const hash = hash8(found.value ?? "");
  if (typeof found.expires !== "number" || found.expires <= 0) {
    return { present: true, expiresAt: 0, valid: false, hash };
  }
  const expiresAt = found.expires * 1000;
  return { present: true, expiresAt, valid: expiresAt > nowMs, hash };
}

/** True when the cached clearance has lapsed and must not be trusted. */
export function isX5secExpired(
  state: Pick<AccountSessionState, "x5secPresent" | "x5secExpiresAt"> | null,
  nowMs: number = Date.now(),
): boolean {
  if (!state || !state.x5secPresent) return true;
  if (!state.x5secExpiresAt) return true;
  return state.x5secExpiresAt <= nowMs;
}

/** Cookie names only — safe for diagnostics. */
export function cookieNames(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((p) => p.split("=")[0]?.trim())
    .filter(Boolean)
    .join(",");
}

const READ_SESSION_FN = (): {
  token: string;
  userAgent: string;
} => {
  let token = "";
  try {
    token = localStorage.getItem("token") || "";
  } catch {
    token = "";
  }
  return { token, userAgent: navigator.userAgent };
};

/**
 * Read the account's live cookie jar + JWT from its own browser page.
 * Requires an initialised account page; it never creates one implicitly, so the
 * caller stays in control of the browser lifecycle.
 */
export async function captureAccountSessionFromPage(
  accountId: string,
  page: Page,
): Promise<AccountSessionState> {
  const cookies = await page.context().cookies();
  const applicable = cookies.filter((c) => {
    const d = c.domain.replace(/^\./, "");
    return (
      c.domain === "chat.qwen.ai" ||
      d === "qwen.ai" ||
      "chat.qwen.ai".endsWith(`.${d}`)
    );
  });
  const cookieHeader = applicable.map((c) => `${c.name}=${c.value}`).join("; ");
  const { token, userAgent } = await page.evaluate(READ_SESSION_FN);
  const x5 = parseX5secFromCookies(applicable);
  const state: AccountSessionState = {
    accountId,
    cookieHeader,
    bearerToken: token,
    userAgent,
    x5secPresent: x5.present,
    x5secExpiresAt: x5.expiresAt,
    x5secHash: x5.hash,
    x5secValid: x5.valid,
    capturedAt: Date.now(),
  };
  sessions.set(accountId, state);
  return state;
}

/**
 * Capture through the account page mutex. Returns null when the account has no
 * live page (cold account) so the caller can fall back to the existing
 * login/recovery machinery instead of inventing a second login path.
 */
export async function captureAccountSession(
  accountId: string,
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<AccountSessionState | null> {
  const cached = sessions.get(accountId);
  if (
    !opts.force &&
    cached &&
    Date.now() - cached.capturedAt < SESSION_TTL_MS
  ) {
    // A lapsed clearance is still re-captured: the jar on disk is the only
    // source of truth for whether a solve happened in the meantime.
    if (cached.x5secValid) return cached;
  }
  try {
    const { withAccountPage } = await import("./playwright.ts");
    return await withAccountPage(
      accountId,
      (page) => captureAccountSessionFromPage(accountId, page),
      opts.timeoutMs ?? config.timeouts.page,
      config.timeouts.page,
      false,
    );
  } catch {
    return null;
  }
}

/** Cached state without touching the browser. */
export function peekAccountSession(
  accountId: string,
): AccountSessionState | null {
  return sessions.get(accountId) ?? null;
}

export function invalidateAccountSession(accountId: string): void {
  sessions.delete(accountId);
}

/**
 * Drop only the clearance, keeping the cookie jar. Used when the upstream
 * challenges us again: the old `x5sec` is suspect even if its TTL has not run
 * out, and the challenge — not a timer — must decide when a new one is minted.
 */
export function invalidateX5sec(accountId: string): void {
  const state = sessions.get(accountId);
  if (!state) return;
  state.x5secPresent = false;
  state.x5secValid = false;
  state.x5secExpiresAt = 0;
  state.x5secHash = null;
}

/** Forget the account entirely (logout, account removal, context reset). */
export function _resetAccountSessionsForTests(): void {
  sessions.clear();
}

/** Sanitized diagnostic view. Contains no secrets by construction. */
export function describeAccountSession(
  state: AccountSessionState | null,
): Record<string, unknown> {
  if (!state) return { present: false };
  return {
    present: true,
    accountId8: hash8(state.accountId),
    cookieLen: state.cookieHeader.length,
    cookieHash: hash8(state.cookieHeader),
    cookieNames: cookieNames(state.cookieHeader),
    bearerLen: state.bearerToken.length,
    bearerHash: hash8(state.bearerToken),
    x5secPresent: state.x5secPresent,
    x5secValid: state.x5secValid,
    x5secTtlMs: state.x5secExpiresAt
      ? Math.max(0, state.x5secExpiresAt - Date.now())
      : 0,
    uaMajor: (state.userAgent.match(/Chrome\/([0-9]+)/) || [])[1] ?? null,
    ageMs: Date.now() - state.capturedAt,
  };
}
