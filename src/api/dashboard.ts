/**
 * QwenProxy dashboard adapter (V1).
 *
 * QwenGate is the functional/visual source of truth; DeepSeek-Gate was used
 * only as the decoupling reference (id-keyed handlers, sessionStorage auth,
 * presentation-only resolvers, strict static whitelist).
 *
 * This module rebuilds the dashboard contract consumed by the QwenGate-style
 * frontend in `src/routes/dashboard/public/` using ONLY real QwenProxy data:
 *
 * - GET /accounts            from loadAccounts + cooldowns + headersReady + leases
 * - GET /pool/stats           from getAccountConcurrencySnapshot + cooldowns
 * - GET /metrics/monitor      last 1000 logical AI requests (aiRing only)
 * - GET /metrics/model-health lifetime per-model counters since process start (not the ring)
 * - GET /metrics/uptime       from process.uptime + package.json version
 * - GET /system/logs          UNSUPPORTED in V1 (no structured log store)
 * - GET /api/config           safe read-only subset (never secrets)
 * - POST /v1/accounts, DELETE /v1/accounts/:id,
 *   POST /v1/accounts/:id/reset-cooldown  (native business logic only)
 *
 * V1 rules enforced here: no synthetic metrics, no invented per-account
 * history, no `disabled` semantics, no passwords/cookies/tokens exposed,
 * no historical persistence, no new business semantics.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import {
  clearAccountCooldown,
  getAccountCooldownInfo,
  isAccountHeadersReady,
} from "../core/account-manager.js";
import {
  addAccount as createAccount,
  loadAccounts,
  removeAccount,
} from "../core/accounts.js";
import { getAccountsByPriority } from "../core/account-priority.js";
import { getAccountConcurrencySnapshot } from "../core/account-concurrency.js";
import { getActivePlaywrightAccountIds } from "../services/playwright.ts";
import { config } from "../core/config.js";
import { getRecentDashboardLogs } from "../core/logger.js";
import {
  getModelHealth,
  getMonitorSummary,
  getRecentAIRequests,
  getRecentNetworkEvents,
  getUsageSummary,
} from "../core/dashboard-stats.js";
import { verifyApiKey } from "./server.js";
import {
  accountsHtml,
  monitorHtml,
  networkHtml,
  overviewHtml,
  settingsHtml,
  usageHtml,
} from "../routes/dashboard/pages.js";

export const dashboardApp = new Hono();

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, "..", "routes", "dashboard", "public");

let packageVersion = "unknown";
try {
  const pkgRaw = readFileSync(
    resolve(HERE, "..", "..", "package.json"),
    "utf-8",
  );
  const parsed: unknown = JSON.parse(pkgRaw);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof (parsed as { version: unknown }).version === "string"
  ) {
    packageVersion = (parsed as { version: string }).version;
  }
} catch {
  packageVersion = "unknown";
}

// ─── Static hosting (strict whitelist, no traversal) ─────────────────────────

const STATIC_MIME: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  svg: "image/svg+xml",
};

// ─── Static files are served by the whitelisted handler below ───

dashboardApp.get("/dashboard/static/:file", (c) => {
  const file = c.req.param("file");
  if (!/^[a-z0-9_-]+\.(css|js|svg)$/i.test(file)) {
    return c.json({ error: "Invalid file" }, 400);
  }
  const filePath = resolve(PUBLIC_DIR, file);
  if (!filePath.startsWith(PUBLIC_DIR + "/") && filePath !== PUBLIC_DIR) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const contentType = STATIC_MIME[ext] ?? "application/octet-stream";
  return c.text(readFileSync(filePath, "utf-8"), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=300",
  });
});

// ─── Pages (public static admin UI; data endpoints below require API key) ────

function serveHtml(html: string) {
  return (c: Context) => {
    const scriptInjection =
      `<script>\nwindow.APP_VERSION = ${JSON.stringify(packageVersion)};\n</script>\n` +
      `<link rel="icon" type="image/svg+xml" href="/dashboard/static/logo.svg">\n`;
    const output = html.replace(/(<script\b)/, `${scriptInjection}$1`);
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';",
    );
    return c.html(output);
  };
}

dashboardApp.get("/dashboard", serveHtml(overviewHtml));
dashboardApp.get("/dashboard/accounts", serveHtml(accountsHtml));
dashboardApp.get("/dashboard/usage", serveHtml(usageHtml));
dashboardApp.get("/dashboard/network", serveHtml(networkHtml));
dashboardApp.get("/dashboard/monitor", serveHtml(monitorHtml));
dashboardApp.get("/dashboard/settings", serveHtml(settingsHtml));
dashboardApp.get("/", (c) => c.redirect("/dashboard", 302));

// ─── Read adapters (real data only) ──────────────────────────────────────────

export interface DashboardAccount {
  id: string;
  email: string;
  ready: boolean;
  available: boolean;
  headersReady: boolean;
  hasActiveContext: boolean;
  cooldown: boolean;
  cooldown_remaining_ms: number | null;
  cooldown_reason: string | null;
  inFlight: number;
  waiting: number;
  priority: number | null;
}

export function buildAccountsList(): DashboardAccount[] {
  const accounts = loadAccounts();
  const snapshotById = new Map(
    getAccountConcurrencySnapshot().map((s) => [s.accountId, s]),
  );
  const priorityOrder = getAccountsByPriority(accounts);
  const priorityIndex = new Map(
    priorityOrder.map((a, i) => [a.id, i] as [string, number]),
  );
  // Memory cooldown map may be empty for entries restored only in the DB
  // (e.g. after restart before first rotation); fall back to the persisted
  // cooldown_until so the dashboard never reports a cooling account as ready.
  const persistedById = new Map(
    accounts.map((a) => [a.id, a] as const),
  );

  const activeContextIds = new Set(getActivePlaywrightAccountIds());

  return accounts.map((a) => {
    const mem = getAccountCooldownInfo(a.id);
    let onCooldown = mem !== null;
    let remainingMs: number | null = mem?.remainingMs ?? null;
    let reason: string | null = mem?.reason ?? null;
    if (!onCooldown) {
      const persisted = persistedById.get(a.id);
      const until = persisted?.cooldown_until ?? 0;
      if (until > Date.now()) {
        onCooldown = true;
        remainingMs = until - Date.now();
        reason = persisted?.cooldown_reason ?? "RateLimited";
      }
    }
    const snap = snapshotById.get(a.id);
    const headersReady = isAccountHeadersReady(a.id);
    return {
      id: a.id,
      email: a.email,
      ready: headersReady && !onCooldown,
      available: !onCooldown,
      headersReady,
      hasActiveContext: activeContextIds.has(a.id),
      cooldown: onCooldown,
      cooldown_remaining_ms: remainingMs,
      cooldown_reason: reason,
      inFlight: snap?.active ?? 0,
      waiting: snap?.waiting ?? 0,
      priority: priorityIndex.get(a.id) ?? null,
    };
  });
}

export function buildPoolStats(): {
  total: number;
  available: number;
  inUse: number;
  waiting: number;
} {
  const list = buildAccountsList();
  return {
    total: list.length,
    available: list.filter((a) => a.available).length,
    inUse: list.reduce((sum, a) => sum + a.inFlight, 0),
    waiting: list.reduce((sum, a) => sum + a.waiting, 0),
  };
}

dashboardApp.get("/accounts", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.json(buildAccountsList());
});

dashboardApp.get("/pool/stats", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.json(buildPoolStats());
});

dashboardApp.get("/metrics/monitor", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  // Monitor is the AI ring only. An empty ring is zero AI requests, never
  // the generic HTTP counters (requests.total / requests.errors).
  const summary = getMonitorSummary();
  const emailById = new Map(
    loadAccounts().map((a) => [a.id, a.email] as [string, string]),
  );
  return c.json({
    totals: summary.totals,
    modeComparison: {
      streaming: summary.modeComparison.streaming,
      nonStreaming: summary.modeComparison.nonStreaming,
    },
    accounts: summary.accounts.map((a) => ({
      email:
        a.accountId === "unknown"
          ? "Unassigned"
          : (emailById.get(a.accountId) ?? a.accountId),
      accountId: a.accountId,
      totalRequests: a.totalRequests,
      successCount: a.successCount,
      errorCount: a.errorCount,
      errorRate: a.errorRate,
      avgLatencyMs: a.avgLatencyMs,
      medianLatencyMs: a.medianLatencyMs,
      p95LatencyMs: a.p95LatencyMs,
      byMode: {
        streaming: a.byMode.streaming,
        nonStreaming: a.byMode.nonStreaming,
      },
      recentErrors: a.recentErrors,
      lastActivity: a.lastActivity,
    })),
    topErrors: summary.topErrors,
    timeRange: summary.timeRange,
    totalEntries: summary.totalEntries,
    capabilities: {
      perAccount: true,
      percentiles: true,
      modes: true,
      topErrors: true,
      window: "Last 1000 logical AI requests",
    },
  });
});

dashboardApp.get("/metrics/model-health", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  // V2: real per-model counters from the AI-request ring, in the exact
  // QwenGate shape the overview table already renders. Empty = no model
  // activity yet (the UI shows its empty state).
  return c.json(getModelHealth());
});

dashboardApp.get("/metrics/uptime", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.json({
    uptimeSeconds: Math.floor(process.uptime()),
    version: packageVersion,
  });
});

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

dashboardApp.get("/system/logs", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  // V2: bounded in-memory Logger ring (redacted on ingest). Query params
  // mirror QwenGate: ?limit=&level= (min level).
  const limit = Math.max(
    1,
    Math.min(
      200,
      Number.parseInt(c.req.query("limit") ?? "100", 10) || 100,
    ),
  );
  const levelParam = (c.req.query("level") ?? "debug").toLowerCase();
  const minLevel = (
    VALID_LOG_LEVELS.has(levelParam) ? levelParam : "debug"
  ) as "debug" | "info" | "warn" | "error";
  return c.json(getRecentDashboardLogs(limit, minLevel));
});

// ─── Usage (V2: real runtime window, never faked history) ────────────────────

dashboardApp.get("/api/usage", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const usage = getUsageSummary();
  const emailById = new Map(
    loadAccounts().map((a) => [a.id, a.email] as [string, string]),
  );
  return c.json({
    window: usage.window,
    totals: usage.totals,
    accounts: usage.accounts.map((a) => ({
      ...a,
      email:
        a.accountId === "unknown"
          ? "Unassigned"
          : (emailById.get(a.accountId) ?? a.accountId),
    })),
    models: usage.models,
    routes: usage.routes,
  });
});

dashboardApp.get("/api/usage/raw", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const limit = Math.max(
    1,
    Math.min(200, Number.parseInt(c.req.query("limit") ?? "100", 10) || 100),
  );
  return c.json(getRecentAIRequests(limit));
});

// ─── Network (V2: passive HTTP ring, auth-protected) ─────────────────────────
// NOTE: the HTML page lives at GET /dashboard/network (registered above);
// this JSON feed uses /dashboard/network/events to avoid a route clash.
dashboardApp.get("/dashboard/network/events", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const limit = Math.max(
    1,
    Math.min(200, Number.parseInt(c.req.query("limit") ?? "50", 10) || 50),
  );
  const emailById = new Map(
    loadAccounts().map((a) => [a.id, a.email] as [string, string]),
  );
  const aiByHttpId = new Map(
    getRecentAIRequests(1000)
      .filter((r) => r.httpRequestId)
      .map((r) => [r.httpRequestId as string, r] as const),
  );
  return c.json({
    entries: getRecentNetworkEvents(limit).map((e) => {
      const detail = aiByHttpId.get(e.requestId);
      return {
        ...e,
        model: detail?.model ?? null,
        stream: detail?.stream ?? null,
        accountEmail: detail?.accountId
          ? (emailById.get(detail.accountId) ?? detail.accountId)
          : null,
        ok: detail ? detail.success : e.status >= 200 && e.status < 300,
        error: detail?.error ?? null,
        errorReason: detail?.errorReason ?? null,
        retryCount: detail?.retryCount ?? 0,
        attemptedAccounts: detail?.attemptedAccounts ?? 1,
      };
    }),
  });
});

// ─── Config (safe read-only subset; PUT disabled in V1) ──────────────────────

dashboardApp.get("/api/config", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const apiKey = process.env.API_KEY || config.apiKey;
  return c.json({
    PORT: String(config.server.port),
    HOST: config.server.host,
    QWEN_BASE_URL: config.qwen.baseUrl,
    QWEN_CHAT_MODE: config.qwen.chatMode,
    QWEN_CHAT_POOL_SIZE: String(config.qwen.chatPoolSize),
    ACCOUNT_MAX_CONCURRENT_STREAMS: String(
      config.concurrency.maxStreamsPerAccount,
    ),
    apiKeyConfigured: Boolean(apiKey),
    readonly: true,
    source: ".env (restart required)",
  });
});

dashboardApp.put("/api/config", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.json(
    {
      error: "Dashboard configuration is read-only in V1 (managed via .env)",
      code: "READ_ONLY",
    },
    405,
  );
});

// ─── Account management (native business logic only) ─────────────────────────

dashboardApp.get("/v1/accounts", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  return c.json(buildAccountsList());
});

dashboardApp.post("/v1/accounts", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const email =
    typeof body === "object" && body !== null
      ? String((body as { email?: unknown }).email ?? "").trim()
      : "";
  const password =
    typeof body === "object" && body !== null
      ? String((body as { password?: unknown }).password ?? "")
      : "";
  if (!email || !password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  try {
    const created = createAccount(email, password);
    return c.json({ ok: true, id: created.id, email: created.email }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("already exists") ? 409 : 400;
    return c.json({ error: message }, status);
  }
});

dashboardApp.delete("/v1/accounts/:id", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const exists = loadAccounts().some((a) => a.id === id);
  if (!exists) {
    return c.json({ error: "Account not found" }, 404);
  }
  removeAccount(id);
  // Drop any in-memory cooldown entry so a removed id never leaks state.
  try {
    clearAccountCooldown(id);
  } catch {
    // Best effort; removal already succeeded.
  }
  return c.json({ ok: true, id });
});

dashboardApp.post("/v1/accounts/:id/reset-cooldown", (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const exists = loadAccounts().some((a) => a.id === id);
  if (!exists) {
    return c.json({ error: "Account not found" }, 404);
  }
  clearAccountCooldown(id);
  return c.json({ ok: true, id, onCooldown: false });
});

dashboardApp.post("/v1/accounts/:id/manual-verification/start", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { startManualVerification } = await import(
      "../services/manual-verification.js"
    );
    const status = await startManualVerification(id);
    return c.json({ ok: true, ...status });
  } catch (err) {
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : 500;
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      status as 400,
    );
  }
});

dashboardApp.get("/v1/accounts/:id/manual-verification/status", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const { getManualVerificationStatus } = await import(
    "../services/manual-verification.js"
  );
  const status = getManualVerificationStatus(id);
  if (!status) return c.json({ ok: true, accountId: id, state: "idle" });
  return c.json({ ok: true, ...status });
});

dashboardApp.post("/v1/accounts/:id/manual-verification/cancel", async (c) => {
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const { cancelManualVerification } = await import(
    "../services/manual-verification.js"
  );
  const status = cancelManualVerification(id);
  if (!status) return c.json({ ok: true, accountId: id, state: "idle" });
  return c.json({ ok: true, ...status });
});

dashboardApp.post("/v1/accounts/:id/probe-settings-auth", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: A/B settings auth (live bearer vs cookie-only)
  // on the live account context. Read-only: no heal, no login, no DB, no
  // cooldown changes. Booleans/codes only in the response.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { probeSettingsAuthAB } = await import("../services/qwen.js");
    const result = await probeSettingsAuthAB(id);
    try {
      console.log(
        `[SettingsAB] account=${id.slice(0, 8)} ` +
          `bearer=${result.bearerStatus}/${result.bearerAppAuthFailure} ` +
          `cookieOnly=${result.cookieStatus}/${result.cookieAppAuthFailure} ` +
          `liveToken=${result.liveTokenPresent} cookies=${result.cookieCount}`,
      );
    } catch {
      // Diagnostics must never break the probe.
    }
    return c.json({ ok: true, accountId: id, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-refresh-structure", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC, single controlled refresh execution. Reports
  // response STRUCTURE only (key names, value types/lengths, booleans).
  // Performs NO writes and triggers NO recovery. Never logs values.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { probeRefreshStructure } = await import("../services/qwen.js");
    const result = await probeRefreshStructure(id);
    try {
      console.log(
        `[RefreshStruct] account=${id.slice(0, 8)} ` +
          `http=${result.httpStatus} success=${result.appSuccess} ` +
          `appFail=${result.appAuthFailure} ` +
          `top=[${result.topKeys.join(",")}]`,
      );
    } catch {
      // Diagnostics must never break the probe.
    }
    return c.json({ ok: true, accountId: id, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-login", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: exactly ONE loginViaApi invocation plus
  // same-context models/settings/create-chat reads. No cooldown changes,
  // no rotation, no loops, no DB writes. Sanitized results only.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { probeLoginOnce } = await import("../services/playwright.js");
    const result = await probeLoginOnce(id);
    try {
      console.log(
        `[LoginProbe] account=${id.slice(0, 8)} loginOk=${result.loginOk} ` +
          `models=${result.models.status} settings=${result.settings.status} ` +
          `create=${result.createChat.status}/${result.createChat.created}`,
      );
    } catch {
      // Diagnostics must never break the probe.
    }
    return c.json({ ok: true, accountId: id, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-capture", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: exactly ONE refreshHeaders(forceReauth=true) on the
  // account, i.e. the internal re-auth -> captureQwenHeaders flow, with NO
  // /v1/chat/completions traffic, no rotation and no cooldown changes.
  // Sanitized result only.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const mode = c.req.query("mode") === "capture" ? "capture" : "refresh";
  const timeoutMs = Math.max(
    5_000,
    Math.min(120_000, Number.parseInt(c.req.query("timeoutMs") ?? "45000", 10) || 45_000),
  );
  const events: Array<Record<string, unknown>> = [];
  try {
    const captureProbe = await import("../services/capture-probe.js");
    captureProbe.beginCaptureTrace(id);
    const startedAt = Date.now();
    let ok = false;
    let errorClass: string | null = null;
    let errorMessage: string | null = null;
    let loginOk: boolean | null = null;
    try {
      if (mode === "capture") {
        // Exercise the UI capture itself: one login, then captureQwenHeaders.
        const { captureQwenHeaders, loginToQwen } = await import(
          "../services/playwright.js"
        );
        const { getAccountCredentials } = await import("../core/accounts.js");
        const creds = getAccountCredentials(id);
        if (creds?.email && creds?.password) {
          loginOk = await loginToQwen(id, creds.email, creds.password, "capture-probe");
        }
        await captureQwenHeaders(id, undefined, timeoutMs);
      } else {
        const { refreshHeaders } = await import("../services/playwright.js");
        await refreshHeaders(id, timeoutMs, true);
      }
      ok = true;
    } catch (err) {
      errorClass =
        err instanceof Error ? err.name : typeof err === "string" ? "string" : "unknown";
      errorMessage =
        err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    }
    for (const e of captureProbe.captureEventsSnapshot(200)) events.push(e);
    const stages = events.map((e) => String(e.stage));
    return c.json({
      ok,
      mode,
      accountId: id,
      loginOk,
      durationMs: Date.now() - startedAt,
      errorClass,
      errorMessage,
      stages,
      events,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-direct-transport", async (c) => {
  // DIAGNOSTIC: isolated direct-web smoke on ONE account. Reads the real Baxia
  // anti-bot material from the live page, then does create-chat + completion as
  // plain HTTP. No composer, no captureQwenHeaders, no /v1 traffic.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const model = c.req.query("model") || "qwen3.8-max";
  const prompt = c.req.query("prompt") || "Responde únicamente: OK";
  try {
    const direct = await import("../services/qwen-direct-transport.js");
    const { getQwenHeaders } = await import("../services/auth-playwright.js");
    const { headers } = await getQwenHeaders(false, id);
    const cookie = headers["cookie"] || "";
    const baxia = await direct.getBaxiaMaterial(id);
    const version = await direct.getFrontendVersion();
    const created = await direct.directCreateChat({
      cookie,
      model,
      baxia,
      version,
    });
    let completion: Record<string, unknown> | null = null;
    if (created.ok && created.chatId) {
      completion = { ...(await direct.directCompletion({
        cookie,
        chatId: created.chatId,
        model,
        content: prompt,
        baxia,
        version,
        timeoutMs: 90_000,
      })) };
    }
    return c.json({
      ok: Boolean(completion && completion.ok),
      accountId: id,
      model,
      authReady: Boolean(cookie && /(?:^|;\s*)token=/.test(cookie)),
      baxiaReady: Boolean(baxia && baxia.fromSdk),
      baxiaFromSdk: baxia ? baxia.fromSdk : false,
      baxiaV: baxia ? baxia.bxV : null,
      baxiaDiag: direct.getLastBaxiaProbe(),
      version,
      createChat: {
        httpStatus: created.httpStatus,
        appSuccess: created.appSuccess,
        ok: created.ok,
        chatId: created.chatId,
        waf: created.waf,
        riskControlled: created.riskControlled,
        contentType: created.contentType,
        errorCode: created.errorCode,
        bodyPreview: created.bodyPreview,
      },
      completion: completion
        ? {
            ok: completion.ok,
            httpStatus: completion.httpStatus,
            contentType: completion.contentType,
            waf: completion.waf,
            sseStarted: completion.sseStarted,
            sseDone: completion.sseDone,
            outputLength: completion.outputLength,
            text: completion.text,
            bodyPreview: completion.bodyPreview,
          }
        : null,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-composer", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: runs ONE real captureQwenHeaders while passively
  // observing the composer (DOM events + generic request observer). It does not
  // modify the capture path. No /v1 traffic, no rotation, no cooldown changes.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const timeoutMs = Math.max(
    5_000,
    Math.min(120_000, Number.parseInt(c.req.query("timeoutMs") ?? "60000", 10) || 60_000),
  );
  try {
    const { probeComposerDuringCapture } = await import("../services/composer-probe.js");
    const { captureQwenHeaders } = await import("../services/playwright.js");
    const result = await probeComposerDuringCapture(id, () =>
      captureQwenHeaders(id, undefined, timeoutMs),
    );
    return c.json({ ok: true, accountId: id, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-settings-update", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: A/B of POST /api/v2/users/user/settings/update in
  // ONE already-authenticated page/context. No re-login, no refresh, no context
  // recreation, no /v1 traffic, no cooldown or rotation changes. Sanitized only.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  const variants = (c.req.query("variants") ?? "proxy,spa")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 8);
  try {
    const { probeSettingsUpdateAB } = await import("../services/qwen.js");
    const results = [];
    for (const v of variants) {
      try {
        results.push(
          await probeSettingsUpdateAB(
            id,
            v as never,
            c.req.query("instruction") ?? "",
          ),
        );
      } catch (err) {
        results.push({
          variant: v,
          status: 0,
          appSuccess: null,
          appUnauthorized: false,
          topKeys: [],
          errorCode: null,
          request: null,
          error: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
        });
      }
    }
    return c.json({ ok: true, accountId: id, results });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.post("/v1/accounts/:id/probe-chat-shaping", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC: fresh loginViaApi, then baseline minimal
  // create-chat, single-header additions (stop at first failure), group
  // tests, and settings/update pre/post comparison — all on the SAME live
  // page/context. No re-auth, no refresh, no cooldown/DB changes, no
  // rotation, no context recreation. Sanitized results only.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { probeChatShaping } = await import("../services/qwen.js");
    const result = await probeChatShaping(id);
    return c.json({ ok: true, accountId: id, ...result });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});

dashboardApp.get("/v1/accounts/:id/session-trace", async (c) => {
  // EXPERIMENTAL DIAGNOSTIC READ: sanitized temporal session-transition
  // trace (ring + baseline + first-failure window). No traffic, no writes.
  const error = verifyApiKey(c);
  if (error) return error;
  const id = c.req.param("id");
  try {
    const { getSessionTrace } = await import("../services/session-tracer.js");
    return c.json({ ok: true, ...getSessionTrace() });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150) },
      500,
    );
  }
});
