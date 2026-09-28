/**
 * Temporal session-transition tracer (diagnostic, single target account).
 *
 * Records sanitized session lifecycle events (names/hashes/counts only —
 * never tokens, cookies, passwords, or bodies) to isolate what changes
 * between a valid session and the first appUnauthorized/401.
 *
 * Target account is fixed to avoid noise; override via QWEN_TRACE_ACCOUNT.
 */
import crypto from "node:crypto";

export const TRACE_TARGET_ACCOUNT =
  process.env.QWEN_TRACE_ACCOUNT || "0b6a5a7b-5385-d8fe-9e98-d78b32d80be6";

export type SessionTraceEvent =
  | "LOGIN_START"
  | "LOGIN_END"
  | "REFRESH_START"
  | "REFRESH_END"
  | "REAUTH_START"
  | "REAUTH_END"
  | "CONTEXT_CREATE"
  | "CONTEXT_CLOSE"
  | "PAGE_CREATE"
  | "PAGE_CLOSE"
  | "SESSIONKEEPER_CLOSE"
  | "DB_SESSION_READ"
  | "DB_SESSION_WRITE"
  | "CAPTURE_START"
  | "CAPTURE_END"
  | "SETTINGS_STATUS"
  | "SETTINGS_UPDATE_STATUS"
  | "CREATE_CHAT_STATUS"
  | "APP_UNAUTHORIZED";

export interface CookieDetail {
  name: string;
  valueHash: string;
  valueLength: number;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface StorageDetail {
  key: string;
  valueHash: string;
  valueLength: number;
}

export interface SessionSnapshot {
  ts: number;
  contextId: string | null;
  pageId: string | null;
  url: string | null;
  origin: string | null;
  tokenHash: string | null;
  tokenPresent: boolean;
  tokenIat: number | null;
  tokenExp: number | null;
  lsKeys: string[] | null;
  lsTokenHash: string | null;
  ssKeys: string[] | null;
  cookieNameHash: string | null;
  cookieCount: number | null;
  cookies: CookieDetail[] | null;
  lsValues: StorageDetail[] | null;
  ssValues: StorageDetail[] | null;
  capturedAt: number | null;
}

export interface SessionTraceEntry {
  ts: number;
  event: SessionTraceEvent;
  detail: string;
  snapshot: SessionSnapshot | null;
}

const RING_SIZE = 300;
const ring: SessionTraceEntry[] = [];

let firstFailureTs: number | null = null;
let windowDumpScheduled = false;

const contextIds = new WeakMap<object, string>();
const pageIds = new WeakMap<object, string>();
let contextCounter = 0;
let pageCounter = 0;

// Per-account session generations: incremented on every successful login.
// Lets observers tell whether a failure belongs to a superseded generation.
const generations = new Map<string, number>();
const loginInflight = new Map<string, string[]>();

export function currentGeneration(accountId: string): number {
  return generations.get(accountId) ?? 0;
}

function bumpGeneration(accountId: string): number {
  const n = (generations.get(accountId) ?? 0) + 1;
  generations.set(accountId, n);
  return n;
}

export function loginOverlapDetected(accountId: string): boolean {
  return (loginInflight.get(accountId) ?? []).length > 1;
}

export function traceContextId(context: object | null): string | null {
  if (!context || typeof context !== "object") return null;
  let id = contextIds.get(context);
  if (!id) {
    contextCounter += 1;
    id = `ctx${contextCounter}`;
    contextIds.set(context, id);
  }
  return id;
}

export function tracePageId(page: object | null): string | null {
  if (!page || typeof page !== "object") return null;
  let id = pageIds.get(page);
  if (!id) {
    pageCounter += 1;
    id = `pg${pageCounter}`;
    pageIds.set(page, id);
  }
  return id;
}

function hashValue(value: string): string {
  try {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  } catch {
    return "hash-error";
  }
}

/** Best-effort JWT expiry + issued-at decode (metadata only, no verify). */
function decodeJwtTimes(token: string): { iat: number | null; exp: number | null } {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return { iat: null, exp: null };
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      Buffer.from(b64, "base64").toString("utf-8"),
    ) as { iat?: unknown; exp?: unknown };
    const iat = typeof json.iat === "number" ? json.iat : null;
    const exp = typeof json.exp === "number" ? json.exp : null;
    return { iat, exp };
  } catch {
    return { iat: null, exp: null };
  }
}

function hashNames(names: string[]): string {
  return hashValue([...names].sort().join(";"));
}

export interface ContextCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export async function snapshotSessionState(
  accountId: string,
  handles: {
    context?: { cookies?: () => Promise<ContextCookie[]> } | null;
    page?: unknown;
  } = {},
): Promise<SessionSnapshot | null> {
  if (accountId !== TRACE_TARGET_ACCOUNT) return null;
  const snap: SessionSnapshot = {
    ts: Date.now(),
    contextId: handles.context ? traceContextId(handles.context) : null,
    pageId: handles.page ? tracePageId(handles.page as object) : null,
    url: null,
    origin: null,
    tokenHash: null,
    tokenPresent: false,
    tokenIat: null,
    tokenExp: null,
    lsKeys: null,
    lsTokenHash: null,
    ssKeys: null,
    cookies: null,
    lsValues: null,
    ssValues: null,
    cookieNameHash: null,
    cookieCount: null,
    capturedAt: null,
  };
  try {
    const pg = handles.page as unknown as {
      url?: () => string;
      evaluate?: (fn: () => unknown) => Promise<unknown>;
    } | null;
    if (pg) {
      try {
        const u = typeof pg.url === "function" ? pg.url() : "";
        if (u) {
          snap.url = u.split("?")[0].slice(0, 80);
          const m = u.match(/^https?:\/\/[^/]+/);
          snap.origin = m ? m[0] : null;
        }
      } catch {
        // Best effort.
      }
      try {
        if (typeof pg.evaluate === "function") {
          const dom = (await pg.evaluate((): unknown => {
            try {
              const ls: string[] = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) ls.push(k);
              }
              ls.sort();
              const ss: string[] = [];
              for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                if (k) ss.push(k);
              }
              ss.sort();
              const t = localStorage.getItem("token");
              let th: string | null = null;
              if (typeof t === "string" && t.length > 0) {
                let h1 = 0x811c9dc5;
                for (let i = 0; i < t.length; i++) {
                  h1 ^= t.charCodeAt(i);
                  h1 = Math.imul(h1, 0x01000193);
                }
                th = (h1 >>> 0).toString(16);
              }
              return { ls, ss, th };
            } catch {
              return null;
            }
          }).catch(() => null)) as {
            ls?: string[];
            ss?: string[];
            th?: string | null;
          } | null;
          if (dom) {
            snap.lsKeys = Array.isArray(dom.ls) ? dom.ls.slice(0, 40) : null;
            snap.ssKeys = Array.isArray(dom.ss) ? dom.ss.slice(0, 40) : null;
            snap.lsTokenHash = typeof dom.th === "string" ? dom.th : null;
          }
          try {
            const det = (await (pg as unknown as {
              evaluate?: (fn: () => unknown) => Promise<unknown>;
            }).evaluate?.((): unknown => {
              try {
                const ls: Array<{ key: string; hash: string; len: number }> = [];
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  if (!k) continue;
                  const v = localStorage.getItem(k) || "";
                  let h1 = 0x811c9dc5;
                  for (let j = 0; j < v.length; j++) {
                    h1 ^= v.charCodeAt(j);
                    h1 = Math.imul(h1, 0x01000193);
                  }
                  ls.push({
                    key: k.slice(0, 80),
                    hash: (h1 >>> 0).toString(16),
                    len: v.length,
                  });
                  if (ls.length >= 40) break;
                }
                const ss: Array<{ key: string; hash: string; len: number }> = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                  const k = sessionStorage.key(i);
                  if (!k) continue;
                  const v = sessionStorage.getItem(k) || "";
                  let h1 = 0x811c9dc5;
                  for (let j = 0; j < v.length; j++) {
                    h1 ^= v.charCodeAt(j);
                    h1 = Math.imul(h1, 0x01000193);
                  }
                  ss.push({
                    key: k.slice(0, 80),
                    hash: (h1 >>> 0).toString(16),
                    len: v.length,
                  });
                  if (ss.length >= 40) break;
                }
                return { ls, ss };
              } catch {
                return null;
              }
            }).catch(() => null)) as {
              ls?: Array<{ key: string; hash: string; len: number }>;
              ss?: Array<{ key: string; hash: string; len: number }>;
            } | null;
            if (det) {
              snap.lsValues = Array.isArray(det.ls)
                ? det.ls.map(
                    (e: { key: string; hash: string; len: number }) => ({
                      key: e.key,
                      valueHash: e.hash,
                      valueLength: e.len,
                    }),
                  )
                : null;
              snap.ssValues = Array.isArray(det.ss)
                ? det.ss.map(
                    (e: { key: string; hash: string; len: number }) => ({
                      key: e.key,
                      valueHash: e.hash,
                      valueLength: e.len,
                    }),
                  )
                : null;
            }
          } catch {
            // Best effort; key names above already recorded.
          }
        }
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Best effort.
  }
  try {
    if (handles.context && typeof handles.context.cookies === "function") {
      const cookies = await handles.context.cookies().catch(() => []);
      const names = cookies.map((c) => c.name);
      snap.cookieCount = names.length;
      snap.cookieNameHash = hashNames(names);
      snap.cookies = cookies.map((c) => ({
        name: c.name,
        valueHash: hashValue(String(c.value ?? "")),
        valueLength: String(c.value ?? "").length,
        domain: String(c.domain ?? ""),
        path: String(c.path ?? ""),
        expires: Number(c.expires ?? 0),
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: String(c.sameSite ?? ""),
      }));
      const tok = cookies.find((c) => c.name === "token");
      if (tok && tok.value) {
        snap.tokenPresent = true;
        snap.tokenHash = hashValue(tok.value);
        const times = decodeJwtTimes(tok.value);
        snap.tokenIat = times.iat;
        snap.tokenExp = times.exp;
      }
    }
  } catch {
    // Best effort.
  }
  try {
    const { getDatabase } = await import("../core/database.ts");
    const row = getDatabase()
      .prepare("SELECT captured_at FROM qwen_auth_sessions WHERE account_id = ?")
      .get(accountId) as { captured_at?: unknown } | undefined;
    const ca = Number(row?.captured_at) || 0;
    snap.capturedAt = ca > 0 ? ca : null;
  } catch {
    // Best effort.
  }
  return snap;
}

function isTarget(accountId: string | undefined): boolean {
  return accountId === TRACE_TARGET_ACCOUNT;
}

export function traceSessionEvent(
  accountId: string | undefined,
  event: SessionTraceEvent,
  detail = "",
  snapshot: SessionSnapshot | null = null,
): void {
  if (!isTarget(accountId)) return;
  if (event === "LOGIN_START") {
    const stack = loginInflight.get(accountId!) ?? [];
    stack.push(`t${Date.now()}`);
    loginInflight.set(accountId!, stack);
    if (stack.length > 1) {
      detail = `${detail} CONCURRENT_LOGIN_DETECTED=true depth=${stack.length}`;
    }
  }
  if (event === "LOGIN_END") {
    const stack = loginInflight.get(accountId!) ?? [];
    stack.pop();
    if (stack.length === 0) loginInflight.delete(accountId!);
    if (/^ok\b/.test(detail)) {
      bumpGeneration(accountId!);
    }
  }
  const gen = currentGeneration(accountId!);
  const entry: SessionTraceEntry = {
    ts: Date.now(),
    event,
    detail: `${detail} gen=${gen}`.slice(0, 160),
    snapshot,
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  try {
    console.log(
      `[SessTrace ${accountId!.slice(0, 8)}] ${event}${detail ? ` ${detail}` : ""}`,
    );
  } catch {
    // Logging must never break flows.
  }
}

export function noteUpstreamAuthResult(
  accountId: string | undefined,
  kind: "settings" | "settings-update" | "create-chat",
  httpStatus: number,
  appFail: boolean,
  snapshot: SessionSnapshot | null = null,
): void {
  if (!isTarget(accountId)) return;
  const ev: SessionTraceEvent =
    kind === "settings"
      ? "SETTINGS_STATUS"
      : kind === "settings-update"
        ? "SETTINGS_UPDATE_STATUS"
        : "CREATE_CHAT_STATUS";
  traceSessionEvent(accountId, ev, `http=${httpStatus} appFail=${appFail}`, snapshot);
  if (httpStatus === 401 || appFail) {
    markFirstFailure(accountId, ev, snapshot);
  }
  void traceLsCheckpoint(accountId, `upstream-${kind}`).catch(() => {});
}

/** Snapshot the live handles of an account without creating anything. */
export async function snapshotForAccount(
  accountId: string,
): Promise<SessionSnapshot | null> {
  if (!isTarget(accountId)) return null;
  try {
    const { getAccountPageSnapshotHandles } = await import("./playwright.ts");
    const h = getAccountPageSnapshotHandles(accountId);
    if (!h) return null;
    return await snapshotSessionState(accountId, {
      context: h.context as { cookies?: () => Promise<Array<{ name: string; value: string }>> },
      page: h.page,
    }).catch(() => null);
  } catch {
    return null;
  }
}

export interface TransitionClassification {
  contextChanged: boolean;
  pageChanged: boolean;
  tokenChanged: boolean;
  cookieSetChanged: boolean;
  cookieNamesAdded: string[];
  cookieNamesRemoved: string[];
  cookieValuesChanged: string[];
  cookieAttrsChanged: Array<{ name: string; fields: string[] }>;
  lsKeysAdded: string[];
  lsKeysRemoved: string[];
  lsValuesChanged: string[];
  ssKeysAdded: string[];
  ssKeysRemoved: string[];
  ssValuesChanged: string[];
  capturedAtChanged: boolean;
  dbStateChanged: boolean;
  tokenExpiredAtFailure: boolean | null;
  tokenTtlAtFailure: number | null;
  loginBetween: boolean;
  refreshBetween: boolean;
  reauthBetween: boolean;
  sessionkeeperBetween: boolean;
  contextRecreateBetween: boolean;
  dbWriteBetween: boolean;
  captureBetween: boolean;
  verdict: "A_TOKEN" | "A_VALUE" | "B_CONTEXT" | "C_PERSISTED" | "D_UPSTREAM" | "UNKNOWN";
}

function snapEqual(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Compare baseline vs fail snapshots + intermediate events (CASO A/B/C/D). */
export function classifyTransition(
  base: SessionSnapshot | null,
  fail: SessionSnapshot | null,
  between: SessionTraceEntry[],
): TransitionClassification {
  const hasEvent = (ev: SessionTraceEvent): boolean =>
    between.some((e) => e.event === ev);
  const contextChanged =
    !!base?.contextId && !!fail?.contextId
      ? !snapEqual(base.contextId, fail.contextId)
      : false;
  const pageChanged =
    !!base?.pageId && !!fail?.pageId
      ? !snapEqual(base.pageId, fail.pageId)
      : false;
  const tokenChanged =
    !!base?.tokenHash && !!fail?.tokenHash
      ? !snapEqual(base.tokenHash, fail.tokenHash)
      : false;
  const cookieSetChanged =
    !!base?.cookieNameHash && !!fail?.cookieNameHash
      ? !snapEqual(base.cookieNameHash, fail.cookieNameHash) ||
        base.cookieCount !== fail.cookieCount
      : false;
  const byName = (
    list: CookieDetail[] | null | undefined,
  ): Map<string, CookieDetail> => {
    const m = new Map<string, CookieDetail>();
    for (const c of list ?? []) m.set(c.name, c);
    return m;
  };
  const baseCookies = byName(base?.cookies);
  const failCookies = byName(fail?.cookies);
  const cookieNamesAdded: string[] = [];
  const cookieNamesRemoved: string[] = [];
  const cookieValuesChanged: string[] = [];
  const cookieAttrsChanged: Array<{ name: string; fields: string[] }> = [];
  if (base?.cookies && fail?.cookies) {
    for (const name of failCookies.keys()) {
      if (!baseCookies.has(name)) cookieNamesAdded.push(name);
    }
    for (const name of baseCookies.keys()) {
      if (!failCookies.has(name)) cookieNamesRemoved.push(name);
      else {
        const a = baseCookies.get(name)!;
        const b = failCookies.get(name)!;
        if (a.valueHash !== b.valueHash || a.valueLength !== b.valueLength) {
          cookieValuesChanged.push(name);
        }
        const fields: string[] = [];
        if (a.expires !== b.expires) fields.push("expires");
        if (a.domain !== b.domain) fields.push("domain");
        if (a.path !== b.path) fields.push("path");
        if (a.httpOnly !== b.httpOnly) fields.push("httpOnly");
        if (a.secure !== b.secure) fields.push("secure");
        if (a.sameSite !== b.sameSite) fields.push("sameSite");
        if (fields.length > 0) cookieAttrsChanged.push({ name, fields });
      }
    }
  }
  const storDiff = (
    a: StorageDetail[] | null | undefined,
    b: StorageDetail[] | null | undefined,
  ): { added: string[]; removed: string[]; changed: string[] } => {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    if (!a || !b) return { added, removed, changed };
    const ma = new Map(a.map((x) => [x.key, x]));
    const mb = new Map(b.map((x) => [x.key, x]));
    for (const k of mb.keys()) if (!ma.has(k)) added.push(k);
    for (const k of ma.keys()) {
      if (!mb.has(k)) removed.push(k);
      else {
        const av = ma.get(k)!;
        const bv = mb.get(k)!;
        if (av.valueHash !== bv.valueHash || av.valueLength !== bv.valueLength) changed.push(k);
      }
    }
    return { added, removed, changed };
  };
  const ls = storDiff(base?.lsValues, fail?.lsValues);
  const ss = storDiff(base?.ssValues, fail?.ssValues);
  const capturedAtChanged =
    base?.capturedAt !== null &&
    base?.capturedAt !== undefined &&
    fail?.capturedAt !== null &&
    fail?.capturedAt !== undefined
      ? base.capturedAt !== fail.capturedAt
      : false;
  const dbStateChanged = capturedAtChanged;
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenExpiredAtFailure =
    fail?.tokenExp !== null && fail?.tokenExp !== undefined
      ? fail.tokenExp <= nowSec
      : null;
  const tokenTtlAtFailure =
    fail?.tokenExp !== null && fail?.tokenExp !== undefined
      ? fail.tokenExp - nowSec
      : null;
  const loginBetween = hasEvent("LOGIN_START") || hasEvent("LOGIN_END");
  const refreshBetween = hasEvent("REFRESH_START") || hasEvent("REFRESH_END");
  const reauthBetween = hasEvent("REAUTH_START") || hasEvent("REAUTH_END");
  const sessionkeeperBetween = hasEvent("SESSIONKEEPER_CLOSE");
  const contextRecreateBetween =
    hasEvent("CONTEXT_CREATE") || hasEvent("CONTEXT_CLOSE");
  const dbWriteBetween = hasEvent("DB_SESSION_WRITE");
  const captureBetween =
    hasEvent("CAPTURE_START") || hasEvent("CAPTURE_END");
  let verdict: TransitionClassification["verdict"] = "UNKNOWN";
  const valueChanged =
    tokenChanged ||
    cookieValuesChanged.length > 0 ||
    ls.changed.length > 0 ||
    ss.changed.length > 0;
  if (tokenChanged) verdict = "A_TOKEN";
  else if (valueChanged) verdict = "A_VALUE";
  else if (contextChanged || pageChanged) verdict = "B_CONTEXT";
  else if (dbStateChanged) verdict = "C_PERSISTED";
  else if (
    base !== null &&
    !loginBetween &&
    !refreshBetween &&
    !reauthBetween &&
    !sessionkeeperBetween &&
    !contextRecreateBetween &&
    !dbWriteBetween &&
    !captureBetween
  ) {
    verdict = "D_UPSTREAM";
  }
  return {
    contextChanged,
    pageChanged,
    tokenChanged,
    cookieSetChanged,
    cookieNamesAdded,
    cookieNamesRemoved,
    cookieValuesChanged,
    cookieAttrsChanged,
    lsKeysAdded: ls.added,
    lsKeysRemoved: ls.removed,
    lsValuesChanged: ls.changed,
    ssKeysAdded: ss.added,
    ssKeysRemoved: ss.removed,
    ssValuesChanged: ss.changed,
    capturedAtChanged,
    dbStateChanged,
    tokenExpiredAtFailure,
    tokenTtlAtFailure,
    loginBetween,
    refreshBetween,
    reauthBetween,
    sessionkeeperBetween,
    contextRecreateBetween,
    dbWriteBetween,
    captureBetween,
    verdict,
  };
}

/**
 * Freeze the first auth failure: HTTP 401/403-auth or appUnauthorized.
 * Never overwritten. Must run BEFORE any recovery (refresh/re-auth).
 */
export function markFirstFailure(
  accountId: string | undefined,
  event: SessionTraceEvent,
  snapshot: SessionSnapshot | null = null,
): void {
  if (!isTarget(accountId)) return;
  if (firstFailureTs !== null) return;
  firstFailureTs = Date.now();
  firstFailureRef = { event, snapshot };
  // PRE-recovery LS/cookie state for the first auth failure. Sampled
  // fire-and-forget so recovery work is never delayed by tracing.
  void traceLsCheckpoint(accountId, "first-auth-failure").catch(() => {});
  if (!windowDumpScheduled) {
    windowDumpScheduled = true;
    setTimeout(() => {
      try {
        dumpFailureWindow();
      } catch {
        // Best effort.
      }
    }, 10_000).unref?.();
  }
}

let firstFailureRef: {
  event: SessionTraceEvent;
  snapshot: SessionSnapshot | null;
} | null = null;

function noteFirstFailure(): void {
  firstFailureTs = Date.now();
  if (windowDumpScheduled) return;
  windowDumpScheduled = true;
  setTimeout(() => {
    try {
      dumpFailureWindow();
    } catch {
      // Best effort.
    }
  }, 10_000).unref?.();
}

export function getFirstFailureTs(): number | null {
  return firstFailureTs;
}

/** LocalStorage.token lifecycle tracking (target account only). */
export interface LsCheckpoint {
  ts: number;
  label: string;
  present: boolean;
  hash: string | null;
  length: number;
  cookiePresent: boolean;
  cookieHash: string | null;
  cookieLength: number;
  match: boolean | null;
  marker: boolean;
  handleAlive: boolean;
  contextId: string | null;
  pageId: string | null;
  url: string | null;
}

export interface LsChangeRecord {
  ts: number;
  event: string;
  caller: string;
  before: LsState;
  after: LsState;
  handleAlive: boolean;
  contextId: string | null;
  pageId: string | null;
}

export interface LsState {
  present: boolean;
  hash: string | null;
  length: number;
}

let lsBaseline: LsState | null = null;
let baseContextId: string | null = null;
let basePageId: string | null = null;
let firstLsChange: LsChangeRecord | null = null;
/** Per-login-generation outcomes, so a re-login cannot erase a prior finding. */
const lsGenerations: Array<{
  baseline: LsState;
  contextId: string | null;
  pageId: string | null;
  firstChange: LsChangeRecord | null;
  closedAt: number;
}> = [];
const lsHistory: LsCheckpoint[] = [];

function hashStrLocal(v: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h1 ^= v.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(16);
}

export function setLsBaseline(state: LsState): void {
  lsBaseline = { present: state.present, hash: state.hash, length: state.length };
  baseContextId = null;
  basePageId = null;
  firstLsChange = null;
}

export function getLsBaseline(): LsState | null {
  return lsBaseline;
}

export function getLsBaselineHandles(): {
  contextId: string | null;
  pageId: string | null;
} {
  return { contextId: baseContextId, pageId: basePageId };
}

export function getFirstLsChange(): LsChangeRecord | null {
  return firstLsChange;
}

/** Labels that represent a page/context (re)creation or teardown boundary. */
const RECREATE_LABELS = new Set([
  "context-close",
  "sessionkeeper-close",
  "init-success",
]);

/**
 * Classify the frozen first LS change (CASO A/B/C/D).
 * Pure: no state mutation, safe to call from the dashboard.
 */
export function classifyLsChange(): {
  case: "A_REMOVED" | "B_ROTATED" | "C_RECREATE_LOSS" | "D_STABLE" | "NO_BASELINE";
  cause: string;
  removed: boolean;
  rotated: boolean;
  recreateLoss: boolean;
  stableUntilFailure: boolean;
  hypothesisRefuted: boolean;
  cookieLsDivergenceCreated: boolean | null;
  afterChangeCookieLsMatch: boolean | null;
  secondsToFailure: number | null;
  changedBeforeAuthFailure: boolean;
  sequence: string[];
} {
  if (!lsBaseline) {
    return {
      case: "NO_BASELINE",
      cause: "no-baseline",
      removed: false,
      rotated: false,
      recreateLoss: false,
      stableUntilFailure: false,
      hypothesisRefuted: false,
      cookieLsDivergenceCreated: null,
      afterChangeCookieLsMatch: null,
      secondsToFailure: null,
      changedBeforeAuthFailure: false,
      sequence: [],
    };
  }
  const failTs = firstFailureTs;
  const last = lsHistory[lsHistory.length - 1] ?? null;
  const beforeFailure = last
    ? lsHistory.filter((e) => e.ts <= (failTs ?? Number.MAX_SAFE_INTEGER))
    : [];
  const stable =
    beforeFailure.length > 0 &&
    beforeFailure.every(
      (e) => e.present === lsBaseline!.present && e.hash === lsBaseline!.hash,
    );
  if (!firstLsChange) {
    return {
      case: "D_STABLE",
      cause: stable ? "no-change-observed" : "no-baseline-match-window",
      removed: false,
      rotated: false,
      recreateLoss: false,
      stableUntilFailure: stable && failTs !== null,
      hypothesisRefuted: stable && failTs !== null,
      cookieLsDivergenceCreated: null,
      afterChangeCookieLsMatch: last?.match ?? null,
      secondsToFailure: null,
      changedBeforeAuthFailure: false,
      sequence: buildSequence(null, failTs),
    };
  }
  const fc = firstLsChange;
  const rawRemoved = fc.before.present && !fc.after.present;
  const rawRotated =
    fc.before.present && fc.after.present && fc.before.hash !== fc.after.hash;
  // A teardown/recreation boundary legitimately drops the old page's storage,
  // so it is never counted as an in-page removal or rotation.
  const recreate = RECREATE_LABELS.has(fc.event) || !fc.handleAlive;
  const removed = rawRemoved && !recreate;
  const rotated = rawRotated && !recreate;
  const afterCp = lsHistory.find((e) => e.ts >= fc.ts) ?? null;
  const sequence = buildSequence(fc.ts, failTs);
  return {
    case: recreate ? "C_RECREATE_LOSS" : removed ? "A_REMOVED" : "B_ROTATED",
    cause: recreate
      ? fc.handleAlive
        ? "context-or-page-recreated"
        : "handle-gone-context-closed"
      : removed
        ? "explicit-remove-clear-or-navigation"
        : "token-rotated-by-upstream-or-refresh",
    removed,
    rotated,
    recreateLoss: recreate,
    stableUntilFailure: false,
    hypothesisRefuted: false,
    cookieLsDivergenceCreated:
      afterCp && afterCp.cookieHash !== null && afterCp.hash !== afterCp.cookieHash
        ? true
        : afterCp && afterCp.cookieHash !== null
          ? false
          : null,
    afterChangeCookieLsMatch: afterCp?.match ?? null,
    secondsToFailure:
      failTs !== null ? Math.max(0, Math.round((failTs - fc.ts) / 1000)) : null,
    changedBeforeAuthFailure: failTs === null ? false : fc.ts <= failTs,
    sequence,
  };
}

function buildSequence(changeTs: number | null, failTs: number | null): string[] {
  const seq: string[] = [];
  for (const e of lsHistory) {
    if (changeTs !== null && e.ts < changeTs) continue;
    seq.push(`${new Date(e.ts).toISOString().slice(11, 19)} ${e.label} present=${e.present} hash=${e.hash} cookie=${e.cookiePresent} match=${e.match} alive=${e.handleAlive}`);
  }
  if (failTs !== null) {
    seq.push(`${new Date(failTs).toISOString().slice(11, 19)} AUTH_FAILURE`);
  }
  return seq.slice(-40);
}

export function getLsHistory(): LsCheckpoint[] {
  return [...lsHistory];
}

/** One in-page observation captured between two subrequests. */
export interface LsObservation {
  label: string;
  ts: number;
  lsPresent: boolean;
  lsHash: string | null;
  lsLength: number;
  marker: boolean;
  cookiePresent: boolean;
  cookieHash: string | null;
  cookieLength: number;
}

export interface IsLoggedInSubResult {
  step: "auths" | "settings" | "refresh";
  httpStatus: number;
  appState: string;
  appSuccess: boolean | null;
  usable: boolean | null;
  responseKeys: string[];
  setCookieObserved: boolean | null;
  lsWriteObserved: boolean | null;
}

/** Ordered in-page observations from the most recent traced probe. */
let isLoggedInObs: LsObservation[] = [];
/** Per-subrequest results from the most recent traced probe. */
let isLoggedInResults: IsLoggedInSubResult[] = [];
/** First rotation across auths / settings / refresh, frozen. */
let firstRotation: {
  step: string;
  ts: number;
  cookieBefore: string | null;
  cookieAfter: string | null;
  lsBefore: boolean;
  lsAfter: boolean;
  markerBefore: boolean;
  markerAfter: boolean;
} | null = null;

export function getIsLoggedInTrace(): {
  observations: LsObservation[];
  results: IsLoggedInSubResult[];
  firstRotation: typeof firstRotation;
  classification: IsLoggedInRotation;
} {
  return {
    observations: [...isLoggedInObs],
    results: [...isLoggedInResults],
    firstRotation,
    classification: classifyIsLoggedInRotation(),
  };
}

export interface IsLoggedInRotation {
  step: "auths" | "settings" | "refresh" | "async-after-auths" | "async-after-settings" | "async-after-refresh" | "none";
  rotationCase: "A" | "B" | "C" | "D" | "UNKNOWN";
  cookieRotated: boolean | null;
  lsRemoved: boolean | null;
  markerAdded: boolean | null;
  cookieBefore: string | null;
  cookieAfter: string | null;
  lsBefore: boolean | null;
  lsAfter: boolean | null;
  markerBefore: boolean | null;
  markerAfter: boolean | null;
  ts: number | null;
  reason: string;
}

/** Pure classifier: which subrequest rotated the cookie and dropped LS. */
export function classifyIsLoggedInRotation(
  obs: LsObservation[] = isLoggedInObs,
): IsLoggedInRotation {
  const none = (reason: string): IsLoggedInRotation => ({
    step: "none",
    rotationCase: "D",
    cookieRotated: null,
    lsRemoved: null,
    markerAdded: null,
    cookieBefore: null,
    cookieAfter: null,
    lsBefore: null,
    lsAfter: null,
    markerBefore: null,
    markerAfter: null,
    ts: null,
    reason,
  });
  const byLabel = (label: string): LsObservation | undefined =>
    obs.find((o) => o.label === label);
  const entry = byLabel("isloggedin-entry") ?? obs[0];
  if (!entry) return none("no-entry-observation");

  const steps: Array<"auths" | "settings" | "refresh"> = [
    "auths",
    "settings",
    "refresh",
  ];
  // A change is attributed to the first pre/post pair (or its deferred
  // samples) that differs from the state the step started with.
  for (const step of steps) {
    const pre = byLabel(`${step}-pre`) ?? entry;
    for (const postLabel of [
      `${step}-post`,
      `${step}-post-50ms`,
      `${step}-post-250ms`,
    ]) {
      const post = byLabel(postLabel);
      if (!post) continue;
      const cookieRotated =
        pre.cookiePresent && post.cookiePresent
          ? pre.cookieHash !== post.cookieHash
          : pre.cookiePresent !== post.cookiePresent;
      const lsRemoved = pre.lsPresent && !post.lsPresent;
      const lsRotated = pre.lsPresent && post.lsPresent && pre.lsHash !== post.lsHash;
      const markerAdded = !pre.marker && post.marker;
      if (!cookieRotated && !lsRemoved && !lsRotated && !markerAdded) continue;
      const rotationCase: "A" | "B" | "C" =
        cookieRotated && (lsRemoved || lsRotated)
          ? "B"
          : cookieRotated
            ? "A"
            : "C";
      const asyncLabel = postLabel !== `${step}-post`;
      return {
        step: asyncLabel ? (`async-after-${step}` as IsLoggedInRotation["step"]) : step,
        rotationCase,
        cookieRotated,
        lsRemoved,
        markerAdded,
        cookieBefore: pre.cookieHash,
        cookieAfter: post.cookieHash,
        lsBefore: pre.lsPresent,
        lsAfter: post.lsPresent,
        markerBefore: pre.marker,
        markerAfter: post.marker,
        ts: post.ts,
        reason: `${postLabel}:${rotationCase}`,
      };
    }
  }
  return none("no-change-across-subrequests");
}

/** Node-side ingestion of the in-page observations (hashed forms only). */
export function ingestIsLoggedInTrace(
  accountId: string | undefined,
  obs: LsObservation[],
  results: IsLoggedInSubResult[],
  handles: { context: object | null; page: object | null; url: string | null } = {
    context: null,
    page: null,
    url: null,
  },
): void {
  if (!isTarget(accountId)) return;
  isLoggedInObs = obs.map((o) => ({ ...o }));
  if (isLoggedInObs.length > 40) {
    isLoggedInObs = isLoggedInObs.slice(0, 40);
  }
  isLoggedInResults = results.map((r) => ({ ...r, responseKeys: [...r.responseKeys] }));
  const contextId = traceContextId(handles.context);
  const pageId = tracePageId(handles.page);
  for (const o of isLoggedInObs) {
    recordLsCheckpoint(accountId!.slice(0, 8), {
      ts: o.ts,
      label: o.label,
      present: o.lsPresent,
      hash: o.lsHash,
      length: o.lsLength,
      cookiePresent: o.cookiePresent,
      cookieHash: o.cookieHash,
      cookieLength: o.cookieLength,
      match:
        o.lsHash !== null && o.cookieHash !== null ? o.lsHash === o.cookieHash : null,
      marker: o.marker,
      handleAlive: true,
      contextId,
      pageId,
      url: handles.url,
    });
  }
  const cls = classifyIsLoggedInRotation(isLoggedInObs);
  if (cls.step !== "none" && !firstRotation) {
    firstRotation = {
      step: cls.step,
      ts: cls.ts ?? Date.now(),
      cookieBefore: cls.cookieBefore,
      cookieAfter: cls.cookieAfter,
      lsBefore: cls.lsBefore === true,
      lsAfter: cls.lsAfter === true,
      markerBefore: cls.markerBefore === true,
      markerAfter: cls.markerAfter === true,
    };
  }
  try {
    console.log(
      `[SessTrace ${accountId!.slice(0, 8)}] ISLOGGEDIN steps=${isLoggedInResults.length} ` +
        `firstRotation=${firstRotation ? firstRotation.step : "none"} ` +
        `case=${cls.rotationCase}`,
    );
  } catch {}
}

/** Pure LS-state change detector (before/after). Null = no change. */
export function detectLsChange(
  before: LsState | null,
  after: LsState,
): { before: LsState; after: LsState } | null {
  if (!before) return null;
  const changed =
    before.present !== after.present ||
    (before.present && after.present && before.hash !== after.hash);
  if (!changed) return null;
  return {
    before: { present: before.present, hash: before.hash, length: before.length },
    after: { present: after.present, hash: after.hash, length: after.length },
  };
}

/** Test-only reset for LS tracking state. */
export function _resetLsTrackingForTests(): void {
  lsBaseline = null;
  baseContextId = null;
  basePageId = null;
  firstLsChange = null;
  firstFailureTs = null;
  firstFailureRef = null;
  lsHistory.length = 0;
  lsGenerations.length = 0;
  isLoggedInObs = [];
  isLoggedInResults = [];
  firstRotation = null;
}

/** Test-only seeding of a synthetic checkpoint (bypasses live page reads). */
export function _seedLsCheckpointForTests(cp: LsCheckpoint): void {
  recordLsCheckpoint("test0000", cp);
}

function mkCp(
  over: Partial<LsCheckpoint> & { label: string },
): LsCheckpoint {
  return {
    ts: over.ts ?? Date.now(),
    label: over.label,
    present: over.present ?? false,
    hash: over.hash ?? null,
    length: over.length ?? 0,
    cookiePresent: over.cookiePresent ?? false,
    cookieHash: over.cookieHash ?? null,
    cookieLength: over.cookieLength ?? 0,
    match: over.match ?? null,
    marker: over.marker ?? false,
    handleAlive: over.handleAlive ?? true,
    contextId: over.contextId ?? "ctxTest",
    pageId: over.pageId ?? "pgTest",
    url: over.url ?? null,
  };
}

export { mkCp as _mkCpForTests };

/**
 * Record a checkpoint: append history, (re)establish the post-install baseline
 * for a new login generation, and freeze the first change of the generation.
 */
function recordLsCheckpoint(
  accountId8: string,
  cp: LsCheckpoint,
): { isBaseline: boolean; changed: boolean } {
  const after: LsState = { present: cp.present, hash: cp.hash, length: cp.length };
  lsHistory.push(cp);
  if (lsHistory.length > 120) lsHistory.splice(0, lsHistory.length - 120);
  // A successful install is the mandatory post-login baseline. The value is
  // read back from the live page, never assumed from install intent. Each
  // install opens a new generation so a later re-login cannot erase what was
  // already observed for the previous session.
  const isBaseline = cp.label === "post-install" && cp.present && !!cp.hash;
  if (isBaseline) {
    if (lsBaseline) {
      lsGenerations.push({
        baseline: lsBaseline,
        contextId: baseContextId,
        pageId: basePageId,
        firstChange: firstLsChange,
        closedAt: cp.ts,
      });
      if (lsGenerations.length > 20) {
        lsGenerations.splice(0, lsGenerations.length - 20);
      }
    }
    lsBaseline = after;
    baseContextId = cp.contextId;
    basePageId = cp.pageId;
    firstLsChange = null;
  }
  const delta = detectLsChange(lsBaseline, after);
  if (delta && !firstLsChange) {
    firstLsChange = {
      ts: cp.ts,
      event: cp.label,
      caller: cp.label,
      before: delta.before,
      after: delta.after,
      handleAlive: cp.handleAlive,
      contextId: cp.contextId,
      pageId: cp.pageId,
    };
    try {
      console.log(
        `[SessTrace ${accountId8}] LS_CHANGE label=${cp.label} ` +
          `before=${delta.before.present}/${delta.before.hash} ` +
          `after=${delta.after.present}/${delta.after.hash} ` +
          `handleAlive=${cp.handleAlive} ctx=${cp.contextId} page=${cp.pageId}`,
      );
    } catch {}
  }
  try {
    console.log(
      `[SessTrace ${accountId8}] LS_CHECK label=${cp.label} ` +
        `present=${cp.present} len=${cp.length} cookie=${cp.cookiePresent} ` +
        `match=${cp.match} handleAlive=${cp.handleAlive} ` +
        `ctx=${cp.contextId} page=${cp.pageId}`,
    );
  } catch {}
  return { isBaseline, changed: !!delta };
}

/** Sample LS + cookie token state; freeze the first change vs baseline. */
export async function traceLsCheckpoint(
  accountId: string | undefined,
  label: string,
): Promise<void> {
  if (!isTarget(accountId)) return;
  try {
    const { getAccountPageSnapshotHandles } = await import("./playwright.ts");
    const h = getAccountPageSnapshotHandles(accountId!);
    let present = false;
    let hash: string | null = null;
    let length = 0;
    let cookiePresent = false;
    let cookieHash: string | null = null;
    let cookieLength = 0;
    let marker = false;
    let contextId: string | null = null;
    let pageId: string | null = null;
    let url: string | null = null;
    if (h) {
      contextId = traceContextId(h.context as object | null);
      pageId = tracePageId(h.page as object | null);
      try {
        url =
          typeof (h.page as { url?: () => string }).url === "function"
            ? (h.page as { url: () => string }).url()
            : null;
      } catch {
        url = null;
      }
      try {
        const pg = h.page as unknown as {
          evaluate?: (fn: () => unknown) => Promise<unknown>;
        };
        if (pg && typeof pg.evaluate === "function") {
          const v = (await pg
            .evaluate((): unknown => {
              try {
                const t = localStorage.getItem("token");
                return {
                  token: typeof t === "string" && t.length > 0 ? t : null,
                  marker: Boolean(localStorage.getItem("qwen_token_logged_out_marker")),
                };
              } catch {
                return null;
              }
            })
            .catch(() => null)) as
            | { token: string | null; marker: boolean }
            | null;
          if (v && typeof v.token === "string" && v.token.length > 0) {
            present = true;
            hash = hashStrLocal(v.token);
            length = v.token.length;
          }
          marker = v?.marker === true;
        }
      } catch {
        // Best effort.
      }
      try {
        const ctx = h.context as unknown as {
          cookies?: () => Promise<Array<{ name: string; value: string }>>;
        };
        if (ctx && typeof ctx.cookies === "function") {
          const cookies = await ctx.cookies().catch(() => []);
          const tok = cookies.find((c) => c.name === "token");
          if (tok && tok.value) {
            cookiePresent = true;
            cookieHash = hashStrLocal(tok.value);
            cookieLength = tok.value.length;
          }
        }
      } catch {
        // Best effort.
      }
    }
    const match =
      hash !== null && cookieHash !== null ? hash === cookieHash : null;
    const cp: LsCheckpoint = {
      ts: Date.now(),
      label,
      present,
      hash,
      length,
      cookiePresent,
      cookieHash,
      cookieLength,
      match,
      marker,
      handleAlive: h !== null,
      contextId,
      pageId,
      url,
    };
    recordLsCheckpoint(accountId!, cp);
  } catch {
    // Tracing must never break flows.
  }
}

export function getSessionTrace(): {
  target: string;
  baseline: SessionTraceEntry | null;
  firstFailureTs: number | null;
  firstFailure: { event: SessionTraceEvent; snapshot: SessionSnapshot | null } | null;
  classification: TransitionClassification | null;
  generation: number;
  loginOverlap: boolean;
  lsBaseline: LsState | null;
  lsBaselineHandles: { contextId: string | null; pageId: string | null };
  firstLsChange: LsChangeRecord | null;
  lsClassification: ReturnType<typeof classifyLsChange>;
  isLoggedIn: {
    observations: LsObservation[];
    results: IsLoggedInSubResult[];
    firstRotation: typeof firstRotation;
    classification: IsLoggedInRotation;
  };
  lsGenerations: Array<{
    baseline: LsState;
    contextId: string | null;
    pageId: string | null;
    firstChange: LsChangeRecord | null;
    closedAt: number;
  }>;
  lsHistory: LsCheckpoint[];
  window: SessionTraceEntry[];
} {
  const okEvents = ring.filter(
    (e) =>
      (e.event === "SETTINGS_STATUS" ||
        e.event === "CREATE_CHAT_STATUS" ||
        e.event === "SETTINGS_UPDATE_STATUS") &&
      !/unauthorized|401/i.test(e.detail) &&
      !/appFail=true/.test(e.detail),
  );
  // Prefer the earliest ok event carrying a snapshot (comparable states).
  const withSnap = okEvents.filter((e) => e.snapshot !== null);
  const base = (withSnap.length > 0 ? withSnap : okEvents)[0] ?? null;
  const from = (firstFailureTs ?? Date.now()) - 120_000;
  const to = (firstFailureTs ?? Date.now()) + 10_000;
  const window = ring.filter((e) => e.ts >= from && e.ts <= to);
  let classification: TransitionClassification | null = null;
  if (firstFailureRef) {
    const between = ring.filter(
      (e) =>
        e.ts >= (base?.ts ?? from) &&
        e.ts <= (firstFailureTs ?? Date.now()) &&
        e !== base,
    );
    classification = classifyTransition(
      base?.snapshot ?? null,
      firstFailureRef.snapshot,
      between,
    );
  }
  return {
    target: TRACE_TARGET_ACCOUNT,
    baseline: base,
    firstFailureTs,
    firstFailure: firstFailureRef,
    classification,
    generation: currentGeneration(TRACE_TARGET_ACCOUNT),
    loginOverlap: loginOverlapDetected(TRACE_TARGET_ACCOUNT),
    lsBaseline,
    lsBaselineHandles: { contextId: baseContextId, pageId: basePageId },
    firstLsChange,
    lsClassification: classifyLsChange(),
    isLoggedIn: {
      observations: isLoggedInObs,
      results: isLoggedInResults,
      firstRotation,
      classification: classifyIsLoggedInRotation(),
    },
    lsGenerations: lsGenerations.map((g) => ({
      baseline: g.baseline,
      contextId: g.contextId,
      pageId: g.pageId,
      firstChange: g.firstChange,
      closedAt: g.closedAt,
    })),
    lsHistory: lsHistory.slice(-30),
    window,
  };
}

function dumpFailureWindow(): void {
  try {
    const t = getSessionTrace();
    console.log(
      `[SessTrace ${t.target.slice(0, 8)}] FAILURE-WINDOW events=${t.window.length} firstFailureTs=${t.firstFailureTs}`,
    );
    if (t.classification) {
      const c = t.classification;
      console.log(
        `[SessTrace ${t.target.slice(0, 8)}] CLASSIFY verdict=${c.verdict} ` +
          `ctxChanged=${c.contextChanged} pgChanged=${c.pageChanged} ` +
          `tokChanged=${c.tokenChanged} ckChanged=${c.cookieSetChanged} ` +
          `ckValChanged=[${c.cookieValuesChanged.join(",")}] ` +
          `ckAdded=[${c.cookieNamesAdded.join(",")}] ckRemoved=[${c.cookieNamesRemoved.join(",")}] ` +
          `lsChanged=[${c.lsValuesChanged.join(",")}] ssChanged=[${c.ssValuesChanged.join(",")}] ` +
          `dbChanged=${c.dbStateChanged} tokExpired=${c.tokenExpiredAtFailure} ` +
          `tokTtl=${c.tokenTtlAtFailure} login=${c.loginBetween} ` +
          `refresh=${c.refreshBetween} reauth=${c.reauthBetween} ` +
          `keeper=${c.sessionkeeperBetween} recreate=${c.contextRecreateBetween} ` +
          `dbWrite=${c.dbWriteBetween} capture=${c.captureBetween}`,
      );
    }
    for (const e of t.window.slice(-40)) {
      const s = e.snapshot;
      console.log(
        `[SessTrace ${t.target.slice(0, 8)}] @${e.ts} ${e.event} ${e.detail} ` +
          (s
            ? `ctx=${s.contextId} pg=${s.pageId} tok=${s.tokenHash} iat=${s.tokenIat} exp=${s.tokenExp} ck=${s.cookieNameHash}/${s.cookieCount} db=${s.capturedAt}`
            : "nosnap"),
      );
    }
  } catch {
    // Best effort.
  }
}
