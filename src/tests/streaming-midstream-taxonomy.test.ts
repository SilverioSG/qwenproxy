import { test } from "node:test";
import assert from "node:assert/strict";

// Regression: one logical cause must yield one terminal dashboard taxonomy
// whether it surfaces pre-response (index.ts via classifyRetryAction) or
// mid-stream (streaming.ts onError via resolveMidStreamDashboardReason).
// Real case: SharedWafCircuitError mid-stream (req e066d357) recorded
// errorReason=stream_error / class=UNKNOWN, while the same error
// pre-response (req 1569b64c) recorded shared_waf_circuit_open / PROTECTION.

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

const { classifyRetryAction } = await import("../routes/chat/retry-policy.ts");
const { resolveMidStreamDashboardReason } = await import(
  "../routes/chat/streaming.ts"
);
const {
  classifyErrorSemantic,
  recordAIRequest,
  getMonitorSummary,
  resetDashboardStatsForTesting,
} = await import("../core/dashboard-stats.ts");
const { SharedWafCircuitError } = await import("../core/waf-circuit.ts");
const { ClientAbortedError } = await import("../core/errors.ts");
const { QwenNetworkError } = await import("../services/qwen.ts");

function wafErr() {
  return new SharedWafCircuitError("punish_url", 42_000);
}

// Pre-response path (index.ts): canonical reference, must stay green.
test("pre-response SharedWafCircuitError -> shared_waf_circuit_open / PROTECTION", () => {
  const reason = classifyRetryAction(wafErr()).reason;
  assert.equal(reason, "shared_waf_circuit_open");
  assert.equal(classifyErrorSemantic(reason), "PROTECTION");
});

// Mid-stream producer: the regression. BEFORE fix this yields
// stream_error / UNKNOWN (fails); AFTER fix shared_waf_circuit_open / PROTECTION.
test("mid-stream SharedWafCircuitError -> shared_waf_circuit_open / PROTECTION", () => {
  const reason = resolveMidStreamDashboardReason(wafErr());
  assert.equal(reason, "shared_waf_circuit_open");
  assert.equal(classifyErrorSemantic(reason), "PROTECTION");
});

// Mid-stream client abort stays an abort, never a failure.
test("mid-stream ClientAbortedError -> client_abort / CLIENT_ABORT", () => {
  const reason = resolveMidStreamDashboardReason(
    new ClientAbortedError("client aborted during stream creation"),
  );
  assert.equal(reason, "client_abort");
  assert.equal(classifyErrorSemantic(reason), "CLIENT_ABORT");
});

// Lease saturation keeps its account-health taxonomy mid-stream.
test("mid-stream account_busy -> account_busy / ACCOUNT_HEALTH", () => {
  const busy = new Error(
    "Account abc busy: timed out after 30000ms waiting for a free slot",
  ) as Error & { code?: string };
  busy.code = "account_busy";
  const reason = resolveMidStreamDashboardReason(busy);
  assert.equal(reason, "account_busy");
  assert.equal(classifyErrorSemantic(reason), "ACCOUNT_HEALTH");
});

// Plain backend failure stays a failure with BACKEND class mid-stream.
test("mid-stream network error stays FAILED / BACKEND", () => {
  const reason = resolveMidStreamDashboardReason(
    new QwenNetworkError("fetch failed"),
  );
  assert.equal(classifyErrorSemantic(reason), "BACKEND");
});

// Base accounting invariants with the unified reasons.
test("unified reasons keep ERRORS = FAILED + ABORTS, PROTECTION subset of FAILED", () => {
  resetDashboardStatsForTesting();
  const rec = (
    id: string,
    success: boolean,
    errorReason: string | null,
    error: string | null = "e",
  ) =>
    recordAIRequest({
      requestId: id,
      route: "Chat",
      model: "qwen-test",
      stream: true,
      accountId: "acc-1",
      latencyMs: 10,
      success,
      error,
      errorReason,
      retryCount: 0,
      attemptedAccounts: 1,
    });
  rec("waf-mid", false, resolveMidStreamDashboardReason(wafErr()), "shared-waf-circuit-open:punish_url");
  rec("abort-mid", false, resolveMidStreamDashboardReason(new ClientAbortedError("x")), "x");
  rec("ok", true, null, null);
  const s = getMonitorSummary();
  assert.equal(s.totals.totalErrors, 2);
  assert.equal(s.totals.failedRequests, 1);
  assert.equal(s.totals.clientAborts, 1);
  assert.equal(s.totals.protectionEvents, 1);
  assert.equal(s.totals.totalErrors, s.totals.failedRequests + s.totals.clientAborts);
  assert.ok(s.totals.protectionEvents <= s.totals.failedRequests);
  resetDashboardStatsForTesting();
});
