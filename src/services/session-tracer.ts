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

export function getSessionTrace(): {
  target: string;
  baseline: SessionTraceEntry | null;
  firstFailureTs: number | null;
  firstFailure: { event: SessionTraceEvent; snapshot: SessionSnapshot | null } | null;
  classification: TransitionClassification | null;
  generation: number;
  loginOverlap: boolean;
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
