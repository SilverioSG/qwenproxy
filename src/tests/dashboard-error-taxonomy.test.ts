import { test } from "node:test";
import assert from "node:assert/strict";

const stats = await import("../core/dashboard-stats.ts");

function rec(
  id: string,
  opts: {
    success: boolean;
    error?: string;
    errorReason?: string;
    retryCount?: number;
    attemptedAccounts?: number;
  },
) {
  stats.recordAIRequest({
    requestId: id,
    route: "Chat",
    model: "qwen-test",
    stream: true,
    accountId: "acc-1",
    latencyMs: 50,
    success: opts.success,
    error: opts.error ?? null,
    errorReason: opts.errorReason ?? null,
    retryCount: opts.retryCount ?? 0,
    attemptedAccounts: opts.attemptedAccounts ?? 1,
  });
}

// A. Counters: 10 total / 7 success / 2 terminal / 1 client_abort.
test("taxonomy counters: errors = failed + aborts", () => {
  stats.resetDashboardStatsForTesting();
  for (let i = 0; i < 7; i++) rec(`ok-${i}`, { success: true });
  rec("t-backend", {
    success: false,
    error: "boom upstream failure",
    errorReason: "upstream_error",
  });
  rec("t-waf", {
    success: false,
    error: "shared-waf-circuit-open:punish_url",
    errorReason: "shared_waf_circuit_open",
  });
  rec("t-abort", {
    success: false,
    error: "client disconnected before stream completed",
    errorReason: "client_abort",
  });
  const s = stats.getMonitorSummary();
  assert.equal(s.totals.totalRequests, 10);
  assert.equal(s.totals.totalSuccess, 7);
  assert.equal(s.totals.totalErrors, 3);
  assert.equal(s.totals.failedRequests, 2);
  assert.equal(s.totals.clientAborts, 1);
  assert.equal(s.totals.protectionEvents, 1);
  // Invariant: ERRORS === FAILED + ABORTS; total === success + errors.
  assert.equal(
    s.totals.totalErrors,
    s.totals.failedRequests + s.totals.clientAborts,
  );
  assert.equal(
    s.totals.totalRequests,
    s.totals.totalSuccess + s.totals.totalErrors,
  );
  stats.resetDashboardStatsForTesting();
});

// B. Protection subset: terminal WAF counts in errors+failed+protection, not aborts.
test("protection event is a subset of failed, never an abort", () => {
  stats.resetDashboardStatsForTesting();
  rec("waf", {
    success: false,
    error: "shared-waf-circuit-open:punish_url",
    errorReason: "shared_waf_circuit_open",
  });
  const s = stats.getMonitorSummary();
  assert.equal(s.totals.totalErrors, 1);
  assert.equal(s.totals.failedRequests, 1);
  assert.equal(s.totals.protectionEvents, 1);
  assert.equal(s.totals.clientAborts, 0);
  const row = s.topErrors.find((e) =>
    e.message.includes("shared-waf-circuit-open"),
  );
  assert.ok(row);
  assert.equal(row.errorReason, "shared_waf_circuit_open");
  assert.equal(row.semanticClass, "PROTECTION");
  stats.resetDashboardStatsForTesting();
});

// C. Client disconnect: error + abort, zero failed.
test("client disconnect counts as abort, not failure", () => {
  stats.resetDashboardStatsForTesting();
  rec("disc", {
    success: false,
    error: "client disconnected before stream completed",
    errorReason: "client_abort",
  });
  const s = stats.getMonitorSummary();
  assert.equal(s.totals.totalErrors, 1);
  assert.equal(s.totals.failedRequests, 0);
  assert.equal(s.totals.clientAborts, 1);
  assert.equal(s.totals.protectionEvents, 0);
  const row = s.topErrors.find((e) => e.message.includes("disconnected"));
  assert.ok(row);
  assert.equal(row.semanticClass, "CLIENT_ABORT");
  stats.resetDashboardStatsForTesting();
});

// D. Same message, different reasons must not merge.
test("top failures group by (reason, message), exposing reason + class", () => {
  stats.resetDashboardStatsForTesting();
  rec("m1", {
    success: false,
    error: "same text",
    errorReason: "upstream_error",
  });
  rec("m2", {
    success: false,
    error: "same text",
    errorReason: "quota_or_rate_limit",
  });
  const s = stats.getMonitorSummary();
  const rows = s.topErrors.filter((e) => e.message === "same text");
  assert.equal(rows.length, 2);
  const classes = new Set(rows.map((r) => r.semanticClass));
  assert.deepEqual(classes, new Set(["BACKEND", "QUOTA"]));
  for (const r of rows) {
    assert.ok(typeof r.errorReason === "string");
    assert.ok(typeof r.error === "string");
    assert.ok(typeof r.count === "number");
  }
  stats.resetDashboardStatsForTesting();
});

// E. Recovered retry: final success leaves no failure/abort/top row.
test("recovered retries (chat state / personalization) leave no failure", () => {
  stats.resetDashboardStatsForTesting();
  // Final records only: the retry loop never writes intermediate attempts.
  rec("chat-progress-ok", {
    success: true,
    retryCount: 2,
    attemptedAccounts: 1,
  });
  rec("not-exist-ok", { success: true, retryCount: 1, attemptedAccounts: 2 });
  rec("pers-failover-ok", {
    success: true,
    retryCount: 1,
    attemptedAccounts: 2,
  });
  const s = stats.getMonitorSummary();
  assert.equal(s.totals.totalRequests, 3);
  assert.equal(s.totals.totalSuccess, 3);
  assert.equal(s.totals.totalErrors, 0);
  assert.equal(s.totals.failedRequests, 0);
  assert.equal(s.totals.clientAborts, 0);
  assert.equal(s.topErrors.length, 0);
  stats.resetDashboardStatsForTesting();
});

// F. Back-compat: legacy fields still exist.
test("legacy monitor fields preserved", () => {
  stats.resetDashboardStatsForTesting();
  rec("ok", { success: true });
  rec("bad", {
    success: false,
    error: "boom",
    errorReason: "upstream_error",
  });
  const s = stats.getMonitorSummary();
  assert.equal(s.totals.totalRequests, 2);
  assert.equal(s.totals.totalSuccess, 1);
  assert.equal(s.totals.totalErrors, 1);
  assert.equal(s.topErrors.length, 1);
  assert.equal(s.topErrors[0].message, "boom");
  assert.equal(s.topErrors[0].count, 1);
  stats.resetDashboardStatsForTesting();
});

test("semantic mapping covers the audited reasons", () => {
  const c = stats.classifyErrorSemantic;
  assert.equal(c("client_abort"), "CLIENT_ABORT");
  assert.equal(c("shared_waf_circuit_open"), "PROTECTION");
  assert.equal(c("waf_probe_rotate"), "PROTECTION");
  assert.equal(c("quota_or_rate_limit"), "QUOTA");
  assert.equal(c("personalization_sync_failed"), "ACCOUNT_HEALTH");
  assert.equal(c("account_initialization_failed"), "ACCOUNT_HEALTH");
  assert.equal(c("upstream_error"), "BACKEND");
  assert.equal(c("network"), "BACKEND");
  assert.equal(c("terminal_local"), "UNKNOWN");
  assert.equal(c(null), "UNKNOWN");
  assert.equal(c(undefined), "UNKNOWN");
});
