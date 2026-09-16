/**
 * Dashboard V1 focal tests (QwenGate adapter).
 *
 * Covers: pages 200, static whitelist + traversal, auth on data endpoints,
 * adapter shapes, unsupported markers, secret redaction, safe account
 * actions. Runs against the Hono app in-process (no network, no upstream).
 *
 * NOTE: account add/remove tests write to the isolated test database
 * (data-test under node:test) with a synthetic address and clean up after
 * themselves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "dashboard-test-key";

const { app } = await import("../api/server.ts");

const AUTH = { Authorization: "Bearer dashboard-test-key" };

async function get(path: string, auth = true): Promise<Response> {
  return app.request(path, { headers: auth ? AUTH : {} });
}

test("dashboard pages serve 200 HTML", async () => {
  for (const path of [
    "/dashboard",
    "/dashboard/accounts",
    "/dashboard/monitor",
    "/dashboard/settings",
  ]) {
    const res = await get(path, false);
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.match(body, /QwenProxy/, `${path} brand`);
    assert.doesNotMatch(body, /window\.API_KEY/, `${path} no embedded key`);
  }
});

test("root redirects to dashboard", async () => {
  const res = await get("/", false);
  assert.equal(res.status, 302);
});

test("static whitelist serves known assets with correct content type", async () => {
  const cases: Array<[string, string]> = [
    ["/dashboard/static/shared.js", "application/javascript"],
    ["/dashboard/static/shared.css", "text/css"],
    ["/dashboard/static/overview.css", "text/css"],
    ["/dashboard/static/accounts.js", "application/javascript"],
    ["/dashboard/static/monitor.js", "application/javascript"],
    ["/dashboard/static/settings.js", "application/javascript"],
    ["/dashboard/static/logo.svg", "image/svg+xml"],
  ];
  for (const [path, contentType] of cases) {
    const res = await get(path, false);
    assert.equal(res.status, 200, path);
    assert.ok(
      (res.headers.get("content-type") ?? "").includes(contentType),
      `${path} content-type`,
    );
  }
});

test("static handler rejects traversal and unknown files", async () => {
  for (const path of [
    "/dashboard/static/../api/dashboard.ts",
    "/dashboard/static/..%2Fapi%2Fdashboard.ts",
    "/dashboard/static/nope.txt",
    "/dashboard/static/.env",
  ]) {
    const res = await get(path, false);
    assert.ok(
      res.status === 400 || res.status === 404,
      `${path} -> ${res.status}`,
    );
  }
  const missing = await get("/dashboard/static/definitely-missing.js", false);
  assert.equal(missing.status, 404);
});

test("data endpoints require auth", async () => {
  for (const path of [
    "/accounts",
    "/pool/stats",
    "/metrics/monitor",
    "/metrics/model-health",
    "/metrics/uptime",
    "/system/logs",
    "/api/config",
    "/v1/accounts",
  ]) {
    const res = await get(path, false);
    assert.equal(res.status, 401, `${path} unauthenticated`);
  }
});

test("/accounts returns real-shape list without secrets", async () => {
  const res = await get("/accounts");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(body));
  for (const a of body) {
    for (const key of [
      "id",
      "email",
      "ready",
      "available",
      "headersReady",
      "cooldown",
      "cooldown_remaining_ms",
      "cooldown_reason",
      "inFlight",
      "waiting",
      "priority",
    ]) {
      assert.ok(key in a, `missing ${key}`);
    }
    const serialized = JSON.stringify(a).toLowerCase();
    assert.doesNotMatch(serialized, /password/);
    assert.doesNotMatch(serialized, /cookie/);
    // No legacy invented semantics.
    assert.ok(!("tokenExpiresInMs" in a));
    assert.ok(!("throttledUntil" in a));
    assert.ok(!("totalRequests" in a));
    assert.ok(!("disabled" in a));
  }
});

test("/pool/stats shape is derived from real pool state", async () => {
  const res = await get("/pool/stats");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of ["total", "available", "inUse", "waiting"]) {
    assert.equal(typeof body[key], "number", key);
  }
});

test("/metrics/monitor uses real counters and marks gaps explicitly", async () => {
  const res = await get("/metrics/monitor");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    totals: Record<string, number | null>;
    capabilities: Record<string, boolean>;
    accounts: unknown[];
    topErrors: unknown[];
  };
  assert.equal(typeof body.totals.totalRequests, "number");
  assert.equal(typeof body.totals.totalErrors, "number");
  assert.equal(
    body.totals.totalSuccess,
    (body.totals.totalRequests as number) -
      (body.totals.totalErrors as number),
  );
  assert.equal(body.totals.p95LatencyMs, null);
  assert.equal(body.totals.medianLatencyMs, null);
  assert.deepEqual(body.accounts, []);
  assert.deepEqual(body.topErrors, []);
  assert.equal(body.capabilities.perAccount, false);
  assert.equal(body.capabilities.percentiles, false);
});

test("/metrics/model-health returns honest empty shape", async () => {
  const res = await get("/metrics/model-health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

test("/metrics/uptime shape", async () => {
  const res = await get("/metrics/uptime");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(typeof body.uptimeSeconds, "number");
  assert.equal(typeof body.version, "string");
});

test("/system/logs is explicitly unsupported (no fake structure)", async () => {
  const res = await get("/system/logs");
  assert.equal(res.status, 501);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, "UNSUPPORTED");
});

test("/api/config exposes safe subset only; PUT is read-only", async () => {
  const res = await get("/api/config");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.readonly, true);
  assert.ok("PORT" in body);
  assert.ok("QWEN_BASE_URL" in body);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /API_KEY.{0,3}":\s*"(?!.*configured)/i);
  assert.ok(!("API_KEY" in body), "raw API key must not be exposed");
  assert.doesNotMatch(serialized.toLowerCase(), /password/);

  const put = await app.request("/api/config", {
    method: "PUT",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ PORT: "9999" }),
  });
  assert.equal(put.status, 405);
});

test("account actions: add -> reset-cooldown -> remove (native logic)", async () => {
  const email = `dashboard-test-${Date.now()}@example.com`;
  const created = await app.request("/v1/accounts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "s3cret-test" }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as Record<string, unknown>;
  assert.equal(createdBody.email, email);
  assert.equal(typeof createdBody.id, "string");
  assert.ok(!("password" in createdBody));
  const id = createdBody.id as string;

  const reset = await app.request(
    `/v1/accounts/${encodeURIComponent(id)}/reset-cooldown`,
    { method: "POST", headers: AUTH },
  );
  assert.equal(reset.status, 200);

  const resetMissing = await app.request(
    "/v1/accounts/does-not-exist/reset-cooldown",
    { method: "POST", headers: AUTH },
  );
  assert.equal(resetMissing.status, 404);

  const removed = await app.request(
    `/v1/accounts/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: AUTH },
  );
  assert.equal(removed.status, 200);

  const removedAgain = await app.request(
    `/v1/accounts/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: AUTH },
  );
  assert.equal(removedAgain.status, 404);
});

test("account add validates input and duplicates", async () => {
  const bad = await app.request("/v1/accounts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "", password: "" }),
  });
  assert.equal(bad.status, 400);

  const email = `dashboard-dup-${Date.now()}@example.com`;
  const first = await app.request("/v1/accounts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "x" }),
  });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as Record<string, unknown>;

  const dup = await app.request("/v1/accounts", {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "y" }),
  });
  assert.equal(dup.status, 409);

  await app.request(
    `/v1/accounts/${encodeURIComponent(firstBody.id as string)}`,
    { method: "DELETE", headers: AUTH },
  );
});

test("existing /health contract is unchanged", async () => {
  const res = await get("/health", false);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of ["status", "timestamp", "metrics"]) {
    assert.ok(key in body, `missing ${key}`);
  }
});
