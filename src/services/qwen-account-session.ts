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

/** The account session cookie; its value is a JWT usable as a Bearer. */
export const ACCOUNT_TOKEN_COOKIE_NAME = "token";

/** Re-capture the jar at most this often (it is cheap: the page is already up). */
const SESSION_TTL_MS = 60_000;

export interface AccountSessionState {
  accountId: string;
  /** Full `Cookie:` header value for chat.qwen.ai. NEVER logged. */
  cookieHeader: string;
  /** Account JWT used as `Authorization: Bearer`. NEVER logged, never printed. */
  bearerToken: string;
  /**
   * Where the Bearer came from. `localStorage` is the browser SPA's own token;
   * `cookie` is the account session cookie. They are DIFFERENT tokens (209 vs
   * 281 chars in practice) and BOTH are accepted by the upstream — verified
   * live: a cookie-sourced Bearer returns `success:true` from /chats/new.
   *
   * Precedence is: persisted DB token -> localStorage token -> live `token`
   * cookie. The DB entry comes first because it is the credential the account
   * is actually authenticated with: measured in production, the token sitting
   * in the live browser context is a DIFFERENT, rejected value (both 209
   * chars), and create-chat answers `Unauthorized` with it, while the persisted
   * one is accepted by every account in the pool.
   *
   * IMPORTANT: the Bearer is the ONLY thing taken from the database. The cookie
   * jar and the `x5sec` clearance always come from the live browser context,
   * because they are WAF/session state rather than a credential, and a stale
   * copy of either would break the clearance path.
   */
  bearerSource: "db" | "localStorage" | "cookie" | "none";
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

/**
 * Immutable snapshot of the clearance that was just REJECTED.
 *
 * It exists so the human-solve wait can tell a genuinely new clearance from the
 * very cookie that failed. The operational cache is invalidated before recovery
 * (the rejected clearance is not trusted), but that must not erase the evidence
 * of what was there.
 */
export interface X5secBaseline {
  present: boolean;
  hash: string | null;
  expiresAt: number;
}

const sessions = new Map<string, AccountSessionState>();

/**
 * Resolves the persisted account token. Injectable so the precedence rules are
 * unit-testable without a database; production always goes through the DB
 * reader. Restored to null by `_resetAccountSessionsForTests`.
 */
let persistedTokenResolver: ((accountId: string) => string) | null = null;

/** @internal test seam */
export function _setPersistedTokenResolverForTests(
  fn: ((accountId: string) => string) | null,
): void {
  persistedTokenResolver = fn;
}

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
/**
 * Normalize a cookie `expires` value to epoch milliseconds.
 *
 * Playwright reports epoch SECONDS, but this repo also persists and restores
 * cookies, and a restored `expires` can arrive in milliseconds, as a relative
 * duration in seconds, or as -1 for a session cookie. Reading a duration as an
 * epoch produced a clearance TTL of ~365 days, which made a stale cookie look
 * valid forever.
 *
 * Returns null for "no usable expiry" (session cookie / unparseable).
 */
export function normalizeCookieExpiryMs(
  expires: unknown,
  nowMs: number = Date.now(),
): number | null {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  // -1 (and any non-positive) means a session cookie: no expiry to compare.
  if (expires <= 0) return null;

  // Decide by proximity to `now` rather than by absolute magnitude: the same
  // number is an epoch only if it lands near the current time. A fixed
  // threshold would misread any clock near a round epoch boundary.
  const PLAUSIBLE_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000; // ~2 years

  // Already epoch milliseconds.
  if (Math.abs(expires - nowMs) <= PLAUSIBLE_WINDOW_MS) return expires;
  // Epoch seconds.
  const asSecondsMs = expires * 1000;
  if (Math.abs(asSecondsMs - nowMs) <= PLAUSIBLE_WINDOW_MS) return asSecondsMs;
  // Neither is plausible as an epoch, so it is a RELATIVE duration in seconds
  // (e.g. 31536000 = one year). Anchoring it to `now` is what stops a
  // one-year duration from being read as 1970 and yielding a ~365-day TTL.
  return nowMs + asSecondsMs;
}

export function parseX5secFromCookies(
  cookies: Array<{ name: string; expires?: number; value?: string }>,
  nowMs: number = Date.now(),
): { present: boolean; expiresAt: number; valid: boolean; hash: string | null } {
  const found = cookies.find((c) => c.name === X5SEC_COOKIE_NAME);
  if (!found) return { present: false, expiresAt: 0, valid: false, hash: null };
  const hash = hash8(found.value ?? "");
  const expiresAt = normalizeCookieExpiryMs(found.expires, nowMs) ?? 0;
  return { present: true, expiresAt, valid: expiresAt > 0 && expiresAt > nowMs, hash };
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
  const { token: lsToken, userAgent } = await page.evaluate(READ_SESSION_FN);
  // Precedence: persisted account credential first (it is the one the upstream
  // actually accepts for this account), then the SPA's own token, then the live
  // `token` cookie. The live cookie is only READ here — the jar itself is
  // untouched, so it keeps flowing on the Cookie header exactly as before, and
  // the live `x5sec` above is unaffected by where the Bearer came from.
  const cookieToken =
    applicable.find((c) => c.name === ACCOUNT_TOKEN_COOKIE_NAME)?.value ?? "";
  let dbToken = "";
  try {
    if (persistedTokenResolver) {
      dbToken = persistedTokenResolver(accountId) || "";
    } else {
      const { getPersistedBearerToken } = await import("../core/database.ts");
      dbToken = getPersistedBearerToken(accountId)?.token ?? "";
    }
  } catch {
    dbToken = "";
  }
  const bearerToken = dbToken || lsToken || cookieToken || "";
  const bearerSource: AccountSessionState["bearerSource"] = dbToken
    ? "db"
    : lsToken
      ? "localStorage"
      : cookieToken
        ? "cookie"
        : "none";
  const x5 = parseX5secFromCookies(applicable);
  console.log(
    `[AccountSession] captured | account=${accountId.slice(0, 8)} | bearer_source=${bearerSource} | ` +
      `bearer_present=${Boolean(bearerToken)} | bearer_length=${bearerToken.length} | ` +
      `cookie_count=${applicable.length} | x5sec_present=${x5.present}`,
  );
  const state: AccountSessionState = {
    accountId,
    cookieHeader,
    bearerToken,
    bearerSource,
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

/**
 * Snapshot the current clearance as a recovery baseline. Call this BEFORE
 * `invalidateX5sec`, which deliberately clears the operational cache.
 */
export function captureX5secBaseline(
  state: AccountSessionState | null,
): X5secBaseline {
  return {
    present: state?.x5secPresent ?? false,
    hash: state?.x5secHash ?? null,
    expiresAt: state?.x5secExpiresAt ?? 0,
  };
}

/**
 * Is the observed clearance genuinely NEW relative to the rejected one?
 *
 * A clearance that is merely present and unexpired is NOT enough: if the very
 * cookie that was refused is still sitting there, nothing was solved. This
 * was the production false positive — recovery reported success in ~2.8s
 * against the unchanged rejected cookie.
 */
export function isNewClearance(
  baseline: X5secBaseline,
  observed: { present: boolean; valid: boolean; hash: string | null },
): boolean {
  if (!observed.present || !observed.valid) return false;
  if (!baseline.present) return true; // nothing was there before
  return observed.hash !== baseline.hash;
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
  persistedTokenResolver = null;
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
