/**
 * Dashboard overview lifetime contract.
 *
 * The Overview "Total Requests" KPI must render the process-lifetime
 * accumulator from /api/usage (labelled "since process start"), never the
 * Monitor ring (last 1000). Ring failure detail may appear only with its own
 * window label. Model Health stays lifetime, Monitor stays ring.
 * Runs in-process with synthetic data only (no production traffic).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "dashboard-overview-test-key";

const { app } = await import("../api/server.ts");
const stats = await import("../core/dashboard-stats.ts");

const AUTH = { Authorization: "Bearer dashboard-overview-test-key" };

test("lifetime accumulator exceeds the ring with synthetic data", async () => {
  stats.resetDashboardStatsForTesting();
  // Mirror the production shape: lifetime 1359 vs ring 1000.
  const N = stats.AI_REQUEST_RING_SIZE + 359;
  for (let i = 0; i < N; i++) {
    stats.recordAIRequest({
      requestId: `ov-${i}`,
      route: "Chat",
      model: i % 2 === 0 ? "model-a" : "model-b",
      stream: true,
      accountId: i % 10 === 0 ? null : "acc-a",
      latencyMs: 20 + (i % 100),
      success: i % 9 !== 0,
      error: i % 9 === 0 ? "boom" : null,
    });
  }
  assert.equal(stats.AI_REQUEST_RING_SIZE, 1000);
  const monitor = stats.getMonitorSummary();
  const usage = stats.getUsageSummary();
  assert.equal(monitor.totals.totalRequests, 1000);
  assert.equal(usage.totals.totalRequests, N);
  assert.ok(usage.totals.totalRequests > monitor.totals.totalRequests);

  // Endpoint level: the exact payloads overview.js consumes.
  const usageRes = await app.request("/api/usage", { headers: AUTH });
  assert.equal(usageRes.status, 200);
  const usageBody = (await usageRes.json()) as {
    totals: { totalRequests: number; successCount: number; errorCount: number };
  };
  assert.equal(usageBody.totals.totalRequests, N);
  assert.equal(
    usageBody.totals.successCount + usageBody.totals.errorCount,
    N,
  );

  const monRes = await app.request("/metrics/monitor", { headers: AUTH });
  const monBody = (await monRes.json()) as {
    totals: { totalRequests: number };
  };
  assert.equal(monBody.totals.totalRequests, 1000);

  // Model Health (the overview table population) is lifetime too.
  const healthRes = await app.request("/metrics/model-health", {
    headers: AUTH,
  });
  const health = (await healthRes.json()) as Record<
    string,
    { successCount: number; errorCount: number }
  >;
  const healthSum = Object.values(health).reduce(
    (s, m) => s + m.successCount + m.errorCount,
    0,
  );
  assert.equal(healthSum, N);
  stats.resetDashboardStatsForTesting();
});

test("overview KPI renders lifetime, ring detail stays labelled", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const vm = await import("node:vm");

  const served = await (
    await app.request("/dashboard/static/overview.js")
  ).text();
  assert.ok(
    served.includes("apiFetch('/api/usage')"),
    "served overview.js fetches the lifetime accumulator",
  );
  assert.ok(
    served.includes("since process start"),
    "lifetime window label present in served overview.js",
  );
  assert.ok(
    !served.includes("setText('kpiTotalRequests', mon.totals"),
    "ring value must never feed the overview Total Requests KPI",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const pub = resolve(here, "..", "routes", "dashboard", "public");
  const sharedJs = readFileSync(resolve(pub, "shared.js"), "utf-8");
  const overviewJs = readFileSync(resolve(pub, "overview.js"), "utf-8");
  assert.equal(served, overviewJs, "served asset matches disk");

  // Stubbed backends: lifetime 1359 (usage) vs ring 1000 (monitor).
  const usagePayload = {
    totals: { totalRequests: 1359, successCount: 1343, errorCount: 16 },
  };
  const monitorPayload = {
    totals: {
      totalRequests: 1000,
      totalSuccess: 989,
      totalErrors: 11,
      failedRequests: 8,
      clientAborts: 3,
      protectionEvents: 7,
    },
  };
  const payloadByUrl = (url: string): unknown => {
    if (url === "/api/usage") return usagePayload;
    if (url === "/metrics/monitor") return monitorPayload;
    if (url === "/metrics/uptime") return { uptimeSeconds: 1 };
    if (url === "/health") return { status: "healthy" };
    if (url === "/accounts") return [];
    return null;
  };

  interface ElStub {
    innerHTML: string;
    textContent: unknown;
    style: Record<string, string>;
  }
  const makeEl = (): ElStub => ({ innerHTML: "", textContent: "", style: {} });
  const elements = new Map<string, ElStub>();
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url: string) => ({
      status: 200,
      ok: true,
      json: async () => payloadByUrl(String(url)),
    }),
    prompt: () => null,
    document: {
      readyState: "loading",
      addEventListener: () => {},
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, makeEl());
        return elements.get(id);
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sharedJs, sandbox);
  vm.runInContext(overviewJs, sandbox);
  await (sandbox.refreshHealth as () => Promise<void>)();

  assert.equal(
    String(elements.get("kpiTotalRequests")?.textContent),
    "1359",
    "overview KPI shows the lifetime total, not the ring",
  );
  const sub = String(elements.get("kpiTotalRequestsSub")?.textContent);
  assert.match(sub, /since process start/, "lifetime figure is labelled");
  assert.match(sub, /last 1000/, "ring figure keeps its own window label");
  assert.match(sub, /16 errors/, "lifetime error count shown");
  assert.match(sub, /8 failed/, "ring failure detail preserved and labelled");
});

test("monitor ring and usage contracts are untouched", async () => {
  const monServed = await (
    await app.request("/dashboard/static/monitor.js")
  ).text();
  assert.match(monServed, /Last 1000 logical AI requests/);
  const usageServed = await (
    await app.request("/dashboard/static/usage.js")
  ).text();
  assert.match(usageServed, /since process start/);
  assert.equal(stats.AI_REQUEST_RING_SIZE, 1000);

  const overviewPage = await (await app.request("/dashboard")).text();
  assert.ok(overviewPage.includes('id="kpiTotalRequests"'));
  assert.ok(overviewPage.includes('id="kpiTotalRequestsSub"'));
});
