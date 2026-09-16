/**
 * Dashboard V2 focal tests (Usage / Network / System Logs / rings).
 *
 * Verifies: QwenGate visual parity (sidebar 6 pages, original logo),
 * real runtime-window usage (no faked history), bounded network/log rings,
 * redaction, auth, honest model-health and populated monitor branch.
 * Runs against the Hono app in-process (no network, no upstream).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "dashboard-v2-test-key";

const { app } = await import("../api/server.ts");
const stats = await import("../core/dashboard-stats.ts");
const { logger } = await import("../core/logger.ts");

const AUTH = { Authorization: "Bearer dashboard-v2-test-key" };

async function get(path: string, auth = true): Promise<Response> {
  return app.request(path, { headers: auth ? AUTH : {} });
}

test("sidebar restores QwenGate parity: 6 pages in original order", async () => {
  const res = await get("/dashboard", false);
  assert.equal(res.status, 200);
  const body = await res.text();
  const hrefs = [
    "/dashboard",
    "/dashboard/accounts",
    "/dashboard/usage",
    "/dashboard/network",
    "/dashboard/monitor",
    "/dashboard/settings",
  ];
  let lastIdx = -1;
  for (const href of hrefs) {
    const idx = body.indexOf(`href="${href}"`);
    assert.ok(idx > lastIdx, `sidebar link ${href} present and ordered`);
    lastIdx = idx;
  }
});

test("original QwenGate logo is served", async () => {
  const res = await get("/dashboard/static/logo.svg", false);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
  const body = await res.text();
  // Original artwork: multi-path 2000x2000 illustration, not the V1 placeholder.
  assert.ok(body.length > 2000, `logo size ${body.length}`);
  assert.match(body, /viewBox="0 0 2000 2000"/);
});

test("usage/network pages serve 200 without secrets", async () => {
  for (const path of ["/dashboard/usage", "/dashboard/network"]) {
    const res = await get(path, false);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.doesNotMatch(body, /window\.API_KEY/);
  }
});

test("new data endpoints require auth", async () => {
  for (const path of [
    "/api/usage",
    "/api/usage/raw",
    "/dashboard/network/events",
  ]) {
    const res = await get(path, false);
    assert.equal(res.status, 401, `${path} unauthenticated`);
  }
});

test("/api/usage exposes an explicit runtime window, no fake history", async () => {
  const res = await get("/api/usage");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  const window = body.window as Record<string, unknown>;
  assert.equal(typeof window.since, "number");
  assert.match(String(window.label), /since process start/);
  for (const key of ["totals", "accounts", "models", "routes"]) {
    assert.ok(key in body, `missing ${key}`);
  }
  const serialized = JSON.stringify(body);
  for (const fake of ['"today"', '"yesterday"', '"week"', '"walls"', '"budget"']) {
    assert.ok(!serialized.includes(fake), `no faked field ${fake}`);
  }
  assert.doesNotMatch(serialized.toLowerCase(), /password/);
});

test("/api/usage/raw returns recent AI records", async () => {
  const res = await get("/api/usage/raw?limit=10");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("network ring is bounded and redacted", async () => {
  stats.resetDashboardStatsForTesting();
  for (let i = 0; i < 250; i++) {
    stats.recordNetworkEvent({
      requestId: `req-${i}`,
      route: "Chat",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      latencyMs: i,
    });
  }
  const recent = stats.getRecentNetworkEvents(500);
  assert.ok(
    recent.length <= stats.NETWORK_RING_SIZE,
    `bounded at ${recent.length}`,
  );
  assert.equal(recent[0].requestId, "req-249");

  const res = await get("/dashboard/network/events?limit=5");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    entries: Array<Record<string, unknown>>;
  };
  assert.ok(Array.isArray(body.entries));
  assert.ok(body.entries.length <= 5);
  const serialized = JSON.stringify(body.entries).toLowerCase();
  assert.doesNotMatch(serialized, /password/);
  assert.doesNotMatch(serialized, /cookie/);
  stats.resetDashboardStatsForTesting();
});

test("middleware propagates X-Request-Id into the network ring", async () => {
  stats.resetDashboardStatsForTesting();
  const res = await app.request("/health", {
    headers: { "X-Request-Id": "dash-probe-123" },
  });
  assert.equal(res.status, 200);
  const [latest] = stats.getRecentNetworkEvents(1);
  assert.equal(latest.requestId, "dash-probe-123");
  assert.equal(latest.path, "/health");
  assert.equal(latest.route, "system");
  assert.equal(typeof latest.latencyMs, "number");

  await app.request("/api/usage", { headers: AUTH });
  const [usageEv] = stats.getRecentNetworkEvents(1);
  assert.equal(usageEv.path, "/api/usage");
  assert.equal(usageEv.route, "dashboard");
  stats.resetDashboardStatsForTesting();
});

test("AI ring aggregates monitor/usage/model-health honestly", async () => {
  stats.resetDashboardStatsForTesting();
  stats.recordAIRequest({
    requestId: "r1",
    route: "Chat",
    model: "qwen-test",
    stream: true,
    accountId: "acc-1",
    latencyMs: 100,
    success: true,
  });
  stats.recordAIRequest({
    requestId: "r2",
    route: "Chat",
    model: "qwen-test",
    stream: false,
    accountId: "acc-1",
    latencyMs: 300,
    success: true,
  });
  stats.recordAIRequest({
    requestId: "r3",
    route: "Anthropic",
    model: "qwen-test",
    stream: true,
    accountId: "acc-2",
    latencyMs: 200,
    success: false,
    error: "boom upstream failure",
    errorReason: "upstream_error",
  });

  const summary = stats.getMonitorSummary();
  assert.equal(summary.totals.totalRequests, 3);
  assert.equal(summary.totals.totalSuccess, 2);
  assert.equal(summary.totals.totalErrors, 1);
  assert.equal(summary.totals.overallAvgLatencyMs, 200);
  assert.equal(summary.totals.medianLatencyMs, 200);
  assert.equal(typeof summary.totals.p95LatencyMs, "number");
  assert.ok(summary.modeComparison.streaming);
  assert.ok(summary.modeComparison.nonStreaming);
  assert.equal(summary.accounts.length, 2);
  const acc2 = summary.accounts.find((a) => a.accountId === "acc-2");
  assert.ok(acc2);
  assert.deepEqual(acc2.recentErrors, ["boom upstream failure"]);
  assert.equal(summary.topErrors.length, 1);
  assert.ok(summary.timeRange);

  const health = stats.getModelHealth();
  assert.deepEqual(health["qwen-test"], {
    successCount: 2,
    errorCount: 1,
    lastActivity: health["qwen-test"].lastActivity,
  });

  const usage = stats.getUsageSummary();
  assert.match(usage.window.label, /since process start/);
  assert.equal(usage.totals.totalRequests, 3);
  assert.equal(usage.models.length, 1);
  assert.equal(usage.routes.length, 2);

  // Populated monitor branch serves resolved per-account rows.
  const res = await get("/metrics/monitor");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    accounts: Array<Record<string, unknown>>;
    capabilities: Record<string, unknown>;
    totals: Record<string, unknown>;
  };
  assert.equal(body.accounts.length, 2);
  assert.equal(body.capabilities.perAccount, true);
  assert.equal(body.capabilities.percentiles, true);
  assert.equal(body.totals.totalRequests, 3);

  const modelRes = await get("/metrics/model-health");
  assert.equal(modelRes.status, 200);
  const modelBody = (await modelRes.json()) as Record<string, unknown>;
  assert.ok("qwen-test" in modelBody);
  stats.resetDashboardStatsForTesting();
});

test("system logs ring captures and redacts Logger output", async () => {
  const secret = "sk-abcdefghij1234567890ABCD";
  logger.warn(`dashboard v2 probe ${secret} end`);
  const res = await get("/system/logs?limit=50&level=debug");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const probe = body.find((e) =>
    String(e.message ?? "").includes("dashboard v2 probe"),
  );
  assert.ok(probe, "probe entry present");
  assert.ok(!String(probe.message).includes(secret), "secret redacted");
  assert.ok(
    String(probe.message).includes("[REDACTED]"),
    "redaction marker present",
  );

  const warnOnly = await get("/system/logs?limit=200&level=error");
  assert.equal(warnOnly.status, 200);
  const warnBody = (await warnOnly.json()) as Array<Record<string, unknown>>;
  for (const e of warnBody) {
    assert.equal(e.level, "error");
  }
});

test("log ring is bounded", async () => {
  const { getRecentDashboardLogs, DASHBOARD_LOG_RING_SIZE } =
    await import("../core/logger.ts");
  for (let i = 0; i < DASHBOARD_LOG_RING_SIZE + 50; i++) {
    logger.warn(`dashboard v2 flood ${i}`);
  }
  assert.ok(
    getRecentDashboardLogs(10000).length <= DASHBOARD_LOG_RING_SIZE,
    "bounded",
  );
});

test("uptime is real on /health and /metrics/uptime", async () => {
  const health = await get("/health", false);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(typeof healthBody.uptime, "number");
  assert.ok((healthBody.uptime as number) >= 0);

  const uptime = await get("/metrics/uptime");
  assert.equal(uptime.status, 200);
  const uptimeBody = (await uptime.json()) as Record<string, unknown>;
  assert.equal(typeof uptimeBody.uptimeSeconds, "number");
  assert.equal(typeof uptimeBody.version, "string");
});

test("error text is truncated and redacted on ingest", async () => {
  stats.resetDashboardStatsForTesting();
  const longError = `x5secdata=${"A".repeat(500)} failure detail`;
  stats.recordAIRequest({
    requestId: "rx",
    route: "Chat",
    model: "m",
    stream: false,
    accountId: null,
    latencyMs: 5,
    success: false,
    error: longError,
  });
  const [rec] = stats.getRecentAIRequests(1);
  assert.ok((rec.error?.length ?? 0) <= 201, "truncated");
  assert.ok(!rec.error?.includes("A".repeat(50)), "secret stripped");
  stats.resetDashboardStatsForTesting();
});

test("public ring producer feeds /system/logs with redaction", async () => {
  const { recordDashboardSystemLog } = await import("../core/logger.ts");
  recordDashboardSystemLog("info", "server", "probe server boot line");
  const res = await get("/system/logs?limit=200&level=debug");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const probe = body.find((e) => e.message === "probe server boot line");
  assert.ok(probe, "public producer entry present");
  assert.equal(probe.category, "server");
  assert.equal(probe.level, "info");

  const secret = "sk-abcdefghij1234567890ABCD";
  recordDashboardSystemLog("error", "server", `probe leak ${secret} end`);
  const res2 = await get("/system/logs?limit=200&level=debug");
  const body2 = (await res2.json()) as Array<Record<string, unknown>>;
  const leaked = body2.find((e) =>
    String(e.message ?? "").includes("probe leak"),
  );
  assert.ok(leaked, "secret probe present");
  assert.ok(!String(leaked.message).includes(secret), "secret redacted");
  assert.ok(
    String(leaked.message).includes("[REDACTED]"),
    "redaction marker present",
  );
});

test("http hook logs AI routes and errors, skips self-poll noise", async () => {
  const loggerMod = await import("../core/logger.ts");

  // Dashboard self-poll success: /health 200 must not add http noise.
  const beforeHealth = loggerMod
    .getRecentDashboardLogs(200, "debug")
    .filter((e) => e.category === "http").length;
  await app.request("/health");
  const afterHealth = loggerMod
    .getRecentDashboardLogs(200, "debug")
    .filter((e) => e.category === "http").length;
  assert.equal(afterHealth, beforeHealth, "no http entry for /health 200");

  // Errors anywhere are genuine signal: unknown route 404 is recorded.
  await app.request("/definitely-not-a-route-xyz");
  const entries = loggerMod.getRecentDashboardLogs(200, "debug");
  const notFound = entries.find(
    (e) =>
      e.category === "http" &&
      String(e.message).includes("/definitely-not-a-route-xyz") &&
      String(e.message).includes("404"),
  );
  assert.ok(notFound, "http DEBUG entry for 404");
  assert.match(String(notFound.message), /^GET \/definitely-not-a-route-xyz 404 \d+ms$/);

  // /system/logs success itself never self-logs (no polling feedback).
  const beforeLogs = loggerMod
    .getRecentDashboardLogs(200, "debug")
    .filter((e) => e.category === "http").length;
  await get("/system/logs?limit=5");
  const afterLogs = loggerMod
    .getRecentDashboardLogs(200, "debug")
    .filter((e) => e.category === "http").length;
  assert.equal(afterLogs, beforeLogs, "no http entry for /system/logs 200");
});

test("syslog dedupe renders log-9/log-10/log-11 exactly once (no string-max freeze)", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const vm = await import("node:vm");

  const served = await (
    await app.request("/dashboard/static/overview.js")
  ).text();
  assert.ok(
    !served.includes("_lastSysLogId"),
    "string-max dedupe pattern is gone from served file",
  );
  assert.ok(
    served.includes("_seenSysLogIds"),
    "seen-ids dedupe present in served file",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const pub = resolve(here, "..", "routes", "dashboard", "public");
  const sharedJs = readFileSync(resolve(pub, "shared.js"), "utf-8");
  const overviewJs = readFileSync(resolve(pub, "overview.js"), "utf-8");

  // Two consecutive polls, newest-first, crossing the 9 -> 10 boundary.
  const polls = [
    [
      { id: "log-9", timestamp: 3, level: "info", category: "server", message: "event log-9" },
      { id: "log-8", timestamp: 2, level: "info", category: "server", message: "event log-8" },
    ],
    [
      { id: "log-11", timestamp: 5, level: "info", category: "server", message: "event log-11" },
      { id: "log-10", timestamp: 4, level: "info", category: "server", message: "event log-10" },
      { id: "log-9", timestamp: 3, level: "info", category: "server", message: "event log-9" },
      { id: "log-8", timestamp: 2, level: "info", category: "server", message: "event log-8" },
    ],
  ];
  let pollIdx = 0;

  const makeEl = () => ({
    innerHTML: "",
    textContent: "",
    style: {},
    insertAdjacentHTML(_pos: string, html: string) {
      (this as { innerHTML: string }).innerHTML = html + (this as { innerHTML: string }).innerHTML;
    },
    querySelectorAll: () => [],
    appendChild: () => {},
  });
  const elements = new Map<string, ReturnType<typeof makeEl>>();
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url: string) => ({
      status: 200,
      ok: true,
      json: async () =>
        String(url).includes("/system/logs")
          ? polls[Math.min(pollIdx++, polls.length - 1)]
          : null,
    }),
    prompt: () => null,
    document: {
      readyState: "loading",
      addEventListener: () => {},
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, makeEl());
        return elements.get(id);
      },
      createElement: () => makeEl(),
      hidden: false,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sharedJs, sandbox);
  vm.runInContext(overviewJs, sandbox);
  await (sandbox.refreshSysLogs as () => Promise<void>)();
  await (sandbox.refreshSysLogs as () => Promise<void>)();

  const html = String(
    (elements.get("sysLogsContainer") as { innerHTML: string }).innerHTML,
  );
  for (const id of ["log-8", "log-9", "log-10", "log-11"]) {
    const count = html.split(`event ${id}`).length - 1;
    assert.equal(count, 1, `${id} rendered exactly once (got ${count})`);
  }
});
