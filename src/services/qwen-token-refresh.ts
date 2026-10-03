/**
 * No-browser Qwen session renewal (modern auth).
 *
 * Contract (validated live against auth.qwen.ai with a persisted
 * refresh_token and no Chromium involved):
 *   GET https://auth.qwen.ai/api/v2/auths/refresh
 *   Cookie: <persisted jar>            (must contain refresh_token)
 *   source: web
 *   x-request-origin: https://chat.qwen.ai
 *   Version: 0.3.11
 *   X-Request-Id: <uuid>
 *   Timezone: <local date string, e.g. "Fri Oct 02 2026 09:15:00 GMT+0200">
 *   accept: application/json, text/plain, *\/\*
 *   origin: https://chat.qwen.ai
 *   referer: https://chat.qwen.ai/
 *   User-Agent: coherent with the account browser
 * No body. No Authorization. No synthetic bx-* headers. No browser.
 *
 * success=true carries the new access token in data.access_token (or
 * data.token). A rotated refresh token may arrive as data.refresh_token (or
 * data.refreshToken); when it does not, the existing one is kept verbatim.
 *
 * Adapted to QwenProxy storage (SQLite qwen_auth_sessions). The architecture
 * is untouched: this module only renews the persisted credential. The
 * browser transport, rotation, cooldowns and streaming keep working as before.
 *
 * SECURITY: nothing here ever logs a token, cookie or jar. Diagnostics carry
 * lengths and name lists only.
 */

import { randomUUID } from "node:crypto";
import { config } from "../core/config.ts";
import { parseJwtExpiry } from "../utils/jwt.ts";

/** Validated refresh endpoint. */
export const QWEN_REFRESH_URL = "https://auth.qwen.ai/api/v2/auths/refresh";
/** Web bundle version the refresh contract was validated with. */
export const QWEN_REFRESH_VERSION = "0.3.11";
/**
 * How close to expiry (ms) an access token may be before it counts as
 * needing a refresh. 5 min covers slow upstream round-trips AND matches the
 * persisted-bearer usability margin: refreshing here guarantees the silent
 * path heals the session before readers treat the bearer as unusable.
 * A smaller value opened a dead window every cycle (fresh=true with no
 * network, yet no usable bearer), parking valid accounts in legacy burns.
 */
export const QWEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Network timeout for one refresh attempt. */
export const QWEN_REFRESH_TIMEOUT_MS = 15_000;
/** Max age of a persisted session row usable for refresh (refresh lifetime). */
export const QWEN_REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RefreshResult {
  ok: boolean;
  /** Machine-readable failure, e.g. NoRefreshMaterial, Http_401, Unauthorized. */
  code?: string;
  /** Human-readable server detail, truncated. Never contains token material. */
  details?: string;
  /** True when the server handed back a different refresh token than we sent. */
  rotated?: boolean;
}

export type RefreshFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Test seam: injected fetch replaces the global one when set. */
let testFetch: RefreshFetch | null = null;

/** @internal test seam */
export function _setRefreshFetchForTests(fn: RefreshFetch | null): void {
  testFetch = fn;
}

function activeFetch(): RefreshFetch {
  if (testFetch) return testFetch;
  return (input, init) => fetch(input, init);
}

/** True in mock-auth suites: there is no persisted session to renew. */
function isAuthMockEnabled(): boolean {
  return (
    process.env.TEST_MOCK_QWEN_AUTH === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

function timezoneString(): string {
  try {
    // Same shape the web client sends and the validated contract expects.
    return new Date().toString().split(" (")[0];
  } catch {
    return "";
  }
}

/**
 * Whether a jar holds what a silent refresh needs: the `refresh_token`
 * cookie. The jar is the credential (cookie transport); the refresh_token
 * column is bookkeeping for rotation detection, not a second gate.
 */
export function hasRefreshMaterial(
  jar: string | null | undefined,
): boolean {
  return !!jar && jar.includes("refresh_token=");
}

/**
 * True when the access token is missing, expired, or inside the refresh
 * margin. A null/unknown expiry is treated as fresh (legacy-tolerant: an
 * opaque token with no parseable exp must not stampede the endpoint — this
 * mirrors isTokenExpiringSoon returning false without an exp claim).
 */
export function needsRefresh(
  tokenExpiresAtSec: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (tokenExpiresAtSec == null || !Number.isFinite(tokenExpiresAtSec)) {
    return false;
  }
  return tokenExpiresAtSec * 1000 <= nowMs + QWEN_REFRESH_MARGIN_MS;
}

/**
 * Set (replace or append) one `name=value` pair inside a
 * `name=value; ...` jar, preserving every other cookie and their order.
 * A function replacer is used so `$` sequences in the value cannot be
 * misread as replacement patterns.
 */
export function setCookiePairInJar(
  jar: string,
  name: string,
  value: string,
): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|; )${escaped}=[^;]*`);
  if (re.test(jar)) {
    return jar.replace(
      re,
      (_m, prefix: string) => `${prefix}${name}=${value}`,
    );
  }
  return jar ? `${jar}; ${name}=${value}` : `${name}=${value}`;
}

/** Replace the refresh_token pair inside a jar (rotation), preserving order. */
export function replaceRefreshInJar(jar: string, next: string): string {
  return setCookiePairInJar(jar, "refresh_token", next);
}

/** Extract the value of one cookie pair from a jar, or null. */
export function getJarPair(
  jar: string,
  name: string,
): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = jar.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

export interface ParsedRefreshBody {
  access: string | null;
  incomingRefresh: string | null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse the refresh response contract (both field-shape variants). Pure. */
export function parseRefreshBody(json: unknown): ParsedRefreshBody {
  const data = (json as any)?.data ?? {};
  const access =
    stringField(data.access_token) ?? stringField(data.token);
  const incomingRefresh =
    stringField(data.refresh_token) ?? stringField(data.refreshToken);
  return { access, incomingRefresh };
}

function refreshFailureCode(json: unknown): {
  code: string;
  details: string;
} {
  const data = (json as any)?.data ?? {};
  const code = String(
    data?.code ?? (json as any)?.code ?? "RefreshRejected",
  );
  const details = String(
    data?.details ?? data?.message ?? (json as any)?.details ?? "no details",
  );
  return { code, details: details.slice(0, 200) };
}

/**
 * Fold Set-Cookie response headers into a jar (rotation path). Pure.
 * Only name=value pairs are merged; attributes are ignored. Names only are
 * safe to surface in diagnostics.
 */
export function mergeSetCookiesIntoJar(
  jar: string,
  setCookies: string[],
): { jar: string; names: string[] } {
  let next = jar;
  const names: string[] = [];
  for (const header of setCookies) {
    const pair = header.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    names.push(name);
    next = setCookiePairInJar(next, name, value);
  }
  return { jar: next, names };
}

function readSetCookies(resp: Response): string[] {
  try {
    const fn = (resp.headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    if (typeof fn === "function") {
      const list = fn.call(resp.headers);
      if (Array.isArray(list)) return list;
    }
  } catch {
    // Fall through: no Set-Cookie support on this Response impl.
  }
  return [];
}

export interface RefreshMaterial {
  jar: string;
  refreshToken: string | null;
  tokenExpiresAtSec: number | null;
  userAgent: string;
}

/**
 * Core renewal against an explicit jar. No storage access here, so the
 * contract is unit-testable with an injected fetch. Returns the new access
 * token, the jar to persist (token pair rewritten, rotation applied,
 * Set-Cookie folded in) and whether the refresh token rotated.
 */
export async function refreshWithJar(
  jar: string,
  previousRefresh: string | null,
  userAgent: string,
  fetchFn: RefreshFetch = activeFetch(),
): Promise<
  | { ok: true; access: string; jar: string; rotated: boolean }
  | { ok: false; code: string; details: string }
> {
  if (!hasRefreshMaterial(jar)) {
    return {
      ok: false,
      code: "NoRefreshMaterial",
      details: "no cookie jar with refresh_token",
    };
  }
  let resp: Response;
  try {
    resp = await fetchFn(QWEN_REFRESH_URL, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        source: "web",
        "x-request-origin": "https://chat.qwen.ai",
        Version: QWEN_REFRESH_VERSION,
        "X-Request-Id": randomUUID(),
        Timezone: timezoneString(),
        origin: "https://chat.qwen.ai",
        referer: "https://chat.qwen.ai/",
        "User-Agent": userAgent || config.auth.userAgent,
        Cookie: jar,
      },
      signal: AbortSignal.timeout(QWEN_REFRESH_TIMEOUT_MS),
    });
  } catch (err: any) {
    const reason =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? "refresh request timed out"
        : `refresh fetch failed: ${err?.message ?? err}`;
    return { ok: false, code: "TransportError", details: reason.slice(0, 200) };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      ok: false,
      code: `Http_${resp.status}`,
      details: text.slice(0, 200) || `HTTP ${resp.status}`,
    };
  }

  const json = (await resp.json().catch(() => null)) as any;
  if (!json || json.success !== true) {
    const { code, details } = refreshFailureCode(json);
    return { ok: false, code, details };
  }

  const { access, incomingRefresh } = parseRefreshBody(json);
  if (!access) {
    return {
      ok: false,
      code: "NoAccessToken",
      details: "success=true but no access token in response",
    };
  }

  const rotated = !!incomingRefresh && incomingRefresh !== previousRefresh;
  let nextJar = setCookiePairInJar(jar, "token", access);
  if (incomingRefresh && incomingRefresh !== previousRefresh) {
    nextJar = replaceRefreshInJar(nextJar, incomingRefresh);
  }
  const { jar: mergedJar, names } = mergeSetCookiesIntoJar(
    nextJar,
    readSetCookies(resp),
  );
  if (names.length > 0) {
    console.log(
      `[AuthRefresh] Set-Cookie folded | names=${names.join(",")} | count=${names.length}`,
    );
  }
  return { ok: true, access, jar: mergedJar, rotated };
}

/**
 * Renew one account's persisted session without opening any browser profile.
 * Material source: the LIVE jar when the account has a warm context (it is
 * the freshest — in-page heals rotate cookies without persisting to SQLite
 * immediately), else the persisted jar. A cold profile is never opened to
 * "read" cookies. On failure the persisted material is left untouched (no
 * wipe without revocation evidence — the caller decides availability).
 */
export async function tryRefreshToken(
  accountId: string,
  opts: { fetchFn?: RefreshFetch } = {},
): Promise<RefreshResult> {
  let material: RefreshMaterial | null;
  try {
    const { getRefreshMaterial } = await import("../core/database.ts");
    material = getRefreshMaterial(accountId);
  } catch (err: any) {
    return {
      ok: false,
      code: "StorageError",
      details: `cannot read persisted session: ${err?.message ?? err}`.slice(
        0,
        200,
      ),
    };
  }
  // Live-first: observe (never open) the warm context's jar when present.
  let source = "persisted";
  try {
    const { peekLiveCookieJar } = await import("./playwright.ts");
    const live = await peekLiveCookieJar(accountId);
    if (live && hasRefreshMaterial(live.jar)) {
      material = {
        jar: live.jar,
        refreshToken:
          material?.refreshToken ??
          getJarPair(live.jar, "refresh_token"),
        tokenExpiresAtSec: material?.tokenExpiresAtSec ?? null,
        userAgent: live.userAgent || material?.userAgent || "",
      };
      source = "live";
    }
  } catch {
    // No live context (or playwright unavailable in tests): persisted stands.
  }
  if (!material || !hasRefreshMaterial(material.jar)) {
    return {
      ok: false,
      code: "NoRefreshMaterial",
      details: "no persisted cookie jar with refresh_token",
    };
  }
  const previousRefresh =
    material.refreshToken ?? getJarPair(material.jar, "refresh_token");

  const out = await refreshWithJar(
    material.jar,
    previousRefresh,
    material.userAgent,
    opts.fetchFn ?? activeFetch(),
  );
  if (!out.ok) {
    return { ok: false, code: out.code, details: out.details };
  }

  // expiresAt derives from the new JWT's own exp (authoritative), falling
  // back to the previous value when the token is opaque.
  const tokenExpiresAtSec = parseJwtExpiry(out.access) ?? undefined;
  try {
    const { saveRefreshedSession } = await import("../core/database.ts");
    saveRefreshedSession(accountId, {
      cookie: out.jar,
      refreshToken: out.rotated
        ? (getJarPair(out.jar, "refresh_token") ?? previousRefresh)
        : undefined,
      tokenExpiresAt: tokenExpiresAtSec,
    });
  } catch (err: any) {
    return {
      ok: false,
      code: "PersistError",
      details: `refresh ok but persist failed: ${err?.message ?? err}`.slice(
        0,
        200,
      ),
    };
  }

  // Best-effort: propagate the fresh jar into the live browser context
  // (when one exists) so the next request serves the new token instead of
  // healing through a 401. No navigation, no profile open — and failures are
  // swallowed: the persisted session is fresh and the existing reactive
  // paths still heal.
  try {
    const { pushRefreshedJarToLiveContext } = await import("./playwright.ts");
    await pushRefreshedJarToLiveContext(accountId, out.jar);
  } catch {
    // No live context, or playwright unavailable (tests): ignore.
  }

  // Never log token material — lengths only.
  console.log(
    `[AuthRefresh] ok | account=${accountId.slice(0, 8)} | source=${source} | access=${out.access.length} chars${out.rotated ? " | refresh rotated" : " | refresh kept"}`,
  );
  return { ok: true, rotated: out.rotated };
}

// Single-flight per account: concurrent requests share one renewal instead
// of stampeding the refresh endpoint. Cleared in `finally`.
const refreshInFlight = new Map<string, Promise<boolean>>();

/** @internal test seam */
export function _resetRefreshSingleFlightForTests(): void {
  refreshInFlight.clear();
}

/** @internal test seam */
export function _refreshSingleFlightSizeForTests(): number {
  return refreshInFlight.size;
}

/**
 * Ensure an account's persisted credential is usable before a request builds
 * upstream headers. Central pre-request hook (streaming, non-streaming,
 * chat, responses/anthropic-via-chat, upload, models all flow through the
 * header/session getters that call this).
 *
 * - access token valid (outside the margin) → true, no network.
 * - expired/near-expiry + refresh material → one shared refresh; true on
 *   success, else true only if the old token is still alive right now.
 * - no material → false; the caller falls back to the existing browser path.
 * - Deliberately no browser fallback here: opening a profile cannot mint a
 *   token without a person, and must never destroy the persisted jar.
 * Never throws.
 */
export async function ensureAccountFresh(
  accountId: string,
  opts: { fetchFn?: RefreshFetch } = {},
): Promise<boolean> {
  if (!accountId) return false;
  if (isAuthMockEnabled()) return true;
  const shared = refreshInFlight.get(accountId);
  if (shared) return shared;
  const run: Promise<boolean> = (async () => {
    try {
      let material: RefreshMaterial | null = null;
      try {
        const { getRefreshMaterial } = await import("../core/database.ts");
        material = getRefreshMaterial(accountId);
      } catch {
        return false;
      }
      if (!material) return false;
      if (!needsRefresh(material.tokenExpiresAtSec)) return true;
      if (hasRefreshMaterial(material.jar)) {
        const result = await tryRefreshToken(accountId, {
          fetchFn: opts.fetchFn,
        });
        if (result.ok) return true;
        console.warn(
          `[AuthRefresh] silent refresh failed | account=${accountId.slice(0, 8)} | code=${result.code ?? "?"} | details=${result.details ?? "no details"}`,
        );
      }
      // A token that is still alive right now (inside the margin but not yet
      // expired, or opaque with no exp) remains usable for this request.
      if (material.tokenExpiresAtSec == null) return true;
      return material.tokenExpiresAtSec * 1000 > Date.now();
    } finally {
      refreshInFlight.delete(accountId);
    }
  })();
  refreshInFlight.set(accountId, run);
  return run;
}
