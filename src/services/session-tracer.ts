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

export interface SessionSnapshot {
  ts: number;
  contextId: string | null;
  pageId: string | null;
  tokenHash: string | null;
  tokenPresent: boolean;
  tokenExp: number | null;
  cookieNameHash: string | null;
  cookieCount: number | null;
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

function hashNames(names: string[]): string {
  return hashValue([...names].sort().join(";"));
}

export async function snapshotSessionState(
  accountId: string,
  handles: {
    context?: { cookies?: () => Promise<Array<{ name: string; value: string }>> } | null;
    page?: unknown;
  } = {},
): Promise<SessionSnapshot | null> {
  if (accountId !== TRACE_TARGET_ACCOUNT) return null;
  const snap: SessionSnapshot = {
    ts: Date.now(),
    contextId: handles.context ? traceContextId(handles.context) : null,
    pageId: handles.page ? tracePageId(handles.page as object) : null,
    tokenHash: null,
    tokenPresent: false,
    tokenExp: null,
    cookieNameHash: null,
    cookieCount: null,
    capturedAt: null,
  };
  try {
    if (handles.context && typeof handles.context.cookies === "function") {
      const cookies = await handles.context.cookies().catch(() => []);
      const names = cookies.map((c) => c.name);
      snap.cookieCount = names.length;
      snap.cookieNameHash = hashNames(names);
      const tok = cookies.find((c) => c.name === "token");
      if (tok && tok.value) {
        snap.tokenPresent = true;
        snap.tokenHash = hashValue(tok.value);
        try {
          const { parseJwtExpiry } = await import("../utils/jwt.ts");
          snap.tokenExp = parseJwtExpiry(tok.value);
        } catch {
          snap.tokenExp = null;
        }
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
  const entry: SessionTraceEntry = {
    ts: Date.now(),
    event,
    detail: detail.slice(0, 160),
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
  if (
    (event === "APP_UNAUTHORIZED" || event === "SETTINGS_STATUS" || event === "SETTINGS_UPDATE_STATUS" || event === "CREATE_CHAT_STATUS") &&
    /unauthorized|401/i.test(detail) &&
    firstFailureTs === null
  ) {
    noteFirstFailure();
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
  if ((httpStatus === 401 || appFail) && firstFailureTs === null) {
    noteFirstFailure();
  }
}

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
  window: SessionTraceEntry[];
} {
  const failures = ring.filter(
    (e) =>
      e.event === "APP_UNAUTHORIZED" ||
      /unauthorized|401/i.test(e.detail),
  );
  const first = failures[0] ?? null;
  const okEvents = ring.filter(
    (e) =>
      (e.event === "SETTINGS_STATUS" ||
        e.event === "CREATE_CHAT_STATUS" ||
        e.event === "SETTINGS_UPDATE_STATUS") &&
      !/unauthorized|401/i.test(e.detail),
  );
  const base = okEvents.length > 0 ? okEvents[0] : null;
  const from = (firstFailureTs ?? Date.now()) - 120_000;
  const to = (firstFailureTs ?? Date.now()) + 10_000;
  return {
    target: TRACE_TARGET_ACCOUNT,
    baseline: base,
    firstFailureTs,
    window: ring.filter((e) => e.ts >= from && e.ts <= to),
  };
}

function dumpFailureWindow(): void {
  try {
    const t = getSessionTrace();
    console.log(
      `[SessTrace ${t.target.slice(0, 8)}] FAILURE-WINDOW events=${t.window.length} firstFailureTs=${t.firstFailureTs}`,
    );
    for (const e of t.window.slice(-40)) {
      const s = e.snapshot;
      console.log(
        `[SessTrace ${t.target.slice(0, 8)}] @${e.ts} ${e.event} ${e.detail} ` +
          (s
            ? `ctx=${s.contextId} pg=${s.pageId} tok=${s.tokenHash} exp=${s.tokenExp} ck=${s.cookieNameHash}/${s.cookieCount} db=${s.capturedAt}`
            : "nosnap"),
      );
    }
  } catch {
    // Best effort.
  }
}
