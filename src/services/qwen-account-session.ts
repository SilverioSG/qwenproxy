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
   * IMPORTANT: the Bearer is the ONLY thing taken from the database when a
   * live browser context exists. The cookie jar and the `x5sec` clearance
   * then come from the live browser context, because they are WAF/session state
   * rather than a credential. EXCEPTION — pair coherence: when the Bearer is
   * the persisted credential, the jar's `token` cookie is aligned to it,
   * because the upstream completion endpoint validates the Bearer/cookie pair
   * (mismatched answers 401 while chats/new still returns 200).
   *
   * COLD exception: with no live page at all, `captureAccountSession` rebuilds
   * the whole state from persisted modern auth (jar + Bearer + userAgent) via
   * `captureAccountSessionFromDb` instead of opening Chromium. A held
   * clearance that went stale is reported by the upstream punish flow, which
   * owns recovery — never confused with an auth failure here.
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
  // Pair coherence: when the Bearer is the persisted DB credential, the jar
  // must be the persisted jar, not the live one. A live context routinely
  // holds rotated non-token cookies from a different session context, and
  // the upstream completion endpoint validates the Bearer/cookie pair:
  // live-jar + db-bearer answers 401 Unauthorized (while chats/new still
  // returns 200), persisted-jar + db-bearer answers 200/OK. Proven by
  // isolated A/B on the same account, same minute, same functions. The full
  // persisted jar is used as-is (probe-proven); a stale held clearance, if
  // any, surfaces as a punish challenge owned by the recovery flow.
  let effectiveCookieHeader = cookieHeader;
  let jarSource = "live";
  if (bearerSource === "db" && bearerToken) {
    try {
      const { getRefreshMaterial } = await import("../core/database.ts");
      const persistedJar = getRefreshMaterial(accountId)?.jar ?? "";
      if (persistedJar) {
        effectiveCookieHeader = persistedJar;
        jarSource = "db";
      }
    } catch {
      // Fall through to the live jar.
    }
    if (jarSource === "live") {
      // Last resort: align at least the token pair (better than a mismatch,
      // worse than the full persisted context above).
      const pairs = effectiveCookieHeader
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      let replaced = false;
      const aligned = pairs.map((pair) => {
        const eq = pair.indexOf("=");
        if (eq > 0 && pair.slice(0, eq).trim() === ACCOUNT_TOKEN_COOKIE_NAME) {
          replaced = true;
          return `${ACCOUNT_TOKEN_COOKIE_NAME}=${bearerToken}`;
        }
        return pair;
      });
      if (!replaced) aligned.unshift(`${ACCOUNT_TOKEN_COOKIE_NAME}=${bearerToken}`);
      effectiveCookieHeader = aligned.join("; ");
    }
  }
  const x5 = parseX5secFromCookies(applicable);
  // When serving the persisted jar, metadata must describe what is SENT, not
  // the live context: presence + fingerprint from the effective jar, expiry
  // unknown (same semantics as the cold bridge).
  let x5present = x5.present;
  let x5expiresAt = x5.expiresAt;
  let x5hash = x5.hash;
  let x5valid = x5.valid;
  if (jarSource === "db") {
    let x5value = "";
    for (const pair of effectiveCookieHeader.split(";").map((p) => p.trim())) {
      const eq = pair.indexOf("=");
      if (eq > 0 && pair.slice(0, eq).trim() === X5SEC_COOKIE_NAME) {
        x5value = pair.slice(eq + 1).trim();
        break;
      }
    }
    x5present = x5value.length > 0;
    x5expiresAt = 0;
    x5hash = x5value ? hash8(x5value) : null;
    x5valid = x5present;
  }
  console.log(
    `[AccountSession] captured | account=${accountId.slice(0, 8)} | bearer_source=${bearerSource} | ` +
      `bearer_present=${Boolean(bearerToken)} | bearer_length=${bearerToken.length} | ` +
      `cookie_count=${applicable.length} | jar_source=${jarSource} | x5sec_present=${x5present}`,
  );
  const state: AccountSessionState = {
    accountId,
    cookieHeader: effectiveCookieHeader,
    bearerToken,
    bearerSource,
    userAgent,
    x5secPresent: x5present,
    x5secExpiresAt: x5expiresAt,
    x5secHash: x5hash,
    x5secValid: x5valid,
    capturedAt: Date.now(),
  };
  sessions.set(accountId, state);
  return state;
}

/**
 * Rebuild an account session from persisted modern auth WITHOUT a browser.
 *
 * Cold path used by `captureAccountSession` when no live page exists: the
 * caller has already run `ensureAccountFresh`, so the persisted access token
 * (and jar, after a rotation) is current. Returns null unless BOTH the
 * persisted jar and the persisted Bearer are usable, in which case the state
 * is cached in `sessions` exactly like a live capture.
 *
 * x5sec: presence + fingerprint come from the persisted jar. The jar carries
 * no per-cookie expiry, so `x5secExpiresAt` is 0 (unknown); a stale held
 * clearance surfaces as an upstream punish challenge, never as auth failure.
 *
 * Never opens Chromium, never logs in, never recovers. Secrets never logged.
 */
export async function captureAccountSessionFromDb(
  accountId: string,
): Promise<AccountSessionState | null> {
  let jar = "";
  let userAgent = "";
  try {
    const { getRefreshMaterial } = await import("../core/database.ts");
    const material = getRefreshMaterial(accountId);
    if (!material || !material.jar) return null;
    jar = material.jar;
    userAgent = material.userAgent || "";
  } catch {
    return null;
  }
  let bearerToken = "";
  try {
    const { getPersistedBearerToken } = await import("../core/database.ts");
    bearerToken = getPersistedBearerToken(accountId)?.token ?? "";
  } catch {
    return null;
  }
  if (!jar || !bearerToken) return null;
  const pairs = jar
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  let x5secValue = "";
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === X5SEC_COOKIE_NAME) {
      x5secValue = pair.slice(eq + 1).trim();
      break;
    }
  }
  const x5secPresent = x5secValue.length > 0;
  const state: AccountSessionState = {
    accountId,
    cookieHeader: jar,
    bearerToken,
    bearerSource: "db",
    userAgent,
    x5secPresent,
    x5secExpiresAt: 0,
    x5secHash: x5secValue ? hash8(x5secValue) : null,
    x5secValid: x5secPresent,
    capturedAt: Date.now(),
  };
  sessions.set(accountId, state);
  console.log(
    `[AccountSession] cold-db | account=${accountId.slice(0, 8)} | bearer_source=db | ` +
      `bearer_present=true | bearer_length=${bearerToken.length} | ` +
      `cookie_count=${pairs.length} | cookie_names=${cookieNames(jar)} | ` +
      `x5sec_present=${x5secPresent} | ua_present=${userAgent.length > 0}`,
  );
  return state;
}

/**
 * Modern-first session revalidation for the chat request path.
 *
 * Returns null when the account holds no usable modern persisted auth (the
 * caller keeps the legacy login/recovery path unchanged), true when a silent
 * refresh confirms the persisted session is fresh, false when modern material
 * exists but is unusable (revoked/expired: classify + rotate, never password
 * login). Never opens Chromium, never searches passwords, never logs secrets.
 */
export async function revalidateModernAccountSession(
  accountId: string,
): Promise<boolean | null> {
  // Gate on refresh MATERIAL (the healable credential), not on a live bearer:
  // an expired access token with a refresh_token jar is exactly what the
  // silent refresh heals. No material at all → null (legacy path unchanged).
  try {
    const { getRefreshMaterial } = await import("../core/database.ts");
    const material = getRefreshMaterial(accountId);
    if (!material || !material.jar) return null;
  } catch {
    return null;
  }
  try {
    const { ensureAccountFresh } = await import("./qwen-token-refresh.ts");
    return await ensureAccountFresh(accountId).catch(() => false);
  } catch {
    return false;
  }
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
  // Modern auth first (best-effort, no browser): renew the persisted access
  // token the Bearer precedence chain reads from, before touching the page.
  try {
    const { ensureAccountFresh } = await import("./qwen-token-refresh.ts");
    await ensureAccountFresh(accountId);
  } catch {
    // Fall through to the existing page/browser machinery.
  }
  // Cold persisted bridge (no browser): with no live page, rebuild from the
  // just-freshened persisted auth instead of opening Chromium. A live page
  // that ALREADY exists keeps preference (fresher jar/clearance) via the
  // withAccountPage path below; this branch never creates one.
  try {
    const { getAccountPageSnapshotHandles } = await import("./playwright.ts");
    if (!getAccountPageSnapshotHandles(accountId)) {
      const cold = await captureAccountSessionFromDb(accountId);
      if (cold) return cold;
    }
  } catch {
    // Fall through to the existing page/browser machinery.
  }
  try {
    const { withAccountPage } = await import("./playwright.ts");
    const live = await withAccountPage(
      accountId,
      (page) => captureAccountSessionFromPage(accountId, page),
      opts.timeoutMs ?? config.timeouts.page,
      config.timeouts.page,
      false,
    ).catch(() => null);
    if (live) return live;
  } catch {
    // Fall through to the cold bridge below.
  }
  // Resilience: a live page that exists but yields nothing (dead context,
  // unusable jar) must not block the persisted session. Last chance before
  // the caller falls back to legacy machinery.
  try {
    const cold = await captureAccountSessionFromDb(accountId);
    if (cold) return cold;
  } catch {
    // Preserve the previous null contract.
  }
  return null;
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
