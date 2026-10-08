/**
 * The direct transport keeps MAX_RECOVERY_RETRIES = 1; when its single recovery
 * cannot obtain a clearance, the EXISTING retry/account policy must treat that
 * one precise case as transient.
 *
 * The point of these tests is the BOUNDARY: only the transport's own
 * clearance-timeout becomes retryable. Auth failures, malformed responses,
 * config errors and every other WAF signal keep their current behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  classifyRetryAction,
  isDirectClearanceExhausted,
  isDirectWafRecoveryUnavailable,
} from "../routes/chat/retry-policy.ts";
import {
  DirectTransportWafBlocked,
  DirectTransportUnsupported,
  isDirectTransportEnabled,
} from "../services/qwen-direct-stream.ts";
import { RetryableQwenStreamError } from "../services/qwen-errors.ts";

// ── the error the transport actually throws ─────────────────────────────────

test("waf failure: clearance timeout is the exact error the transport throws", () => {
  const err = new DirectTransportWafBlocked(true, false);
  assert.equal(err.name, "DirectTransportWafBlocked");
  assert.equal(err.blockReason, "clearance-timeout");
  assert.equal(err.message, "direct-transport-waf-clearance-timeout");
  assert.equal(err.recoveryAttempted, true);
  assert.equal(err.recoverySucceeded, false);
  // It is NOT matched by the pre-existing anti-bot matcher: the transport's own
  // typed error carries a precise reason instead of loose prose, which is what
  // keeps this case from being swept in with every other WAF signal.
  assert.equal(isDirectClearanceExhausted(err), true);
});

test("waf failure: the three block reasons stay distinct", () => {
  const noRecovery = new DirectTransportWafBlocked(false, false);
  const timeout = new DirectTransportWafBlocked(true, false);
  const refused = new DirectTransportWafBlocked(true, true);
  assert.equal(noRecovery.blockReason, "no-recovery");
  assert.equal(timeout.blockReason, "clearance-timeout");
  assert.equal(refused.blockReason, "retry-refused");
  // Only the middle one is the transient-retryable case.
  assert.equal(isDirectClearanceExhausted(noRecovery), false);
  assert.equal(isDirectClearanceExhausted(timeout), true);
  assert.equal(isDirectClearanceExhausted(refused), false);
});

// ── classification: precise vs indiscriminate ───────────────────────────────

test("policy: clearance timeout is classified retryable/transient", () => {
  const action = classifyRetryAction(new DirectTransportWafBlocked(true, false));
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "direct_waf_clearance_timeout");
  // Same account first; the caller's own rotation still applies if it fails.
  assert.equal(action.switchAccount, false);
  // A fresh chat is mandatory: the pre-solve chatId is unusable.
  assert.equal(action.forceNewChat, true);
  assert.equal(action.retryAfterMs >= 0, true);
});

test("policy: a second transport-level recovery stays forbidden", () => {
  // "retry-refused" means the single leg was already spent and the upstream
  // refused again: the transport must not loop, so this is NOT handed to the
  // clearance-retry branch.
  const refused = new DirectTransportWafBlocked(true, true);
  assert.equal(isDirectClearanceExhausted(refused), false);
  const action = classifyRetryAction(refused);
  assert.notEqual(action.reason, "direct_waf_clearance_timeout");
  // A challenge with no recoverable account is terminal, not retried: rotating
  // accounts would only mask the misconfiguration.
  const noRecovery = new DirectTransportWafBlocked(false, false);
  assert.equal(isDirectWafRecoveryUnavailable(noRecovery), true);
  const nrAction = classifyRetryAction(noRecovery);
  assert.equal(nrAction.reason, "direct_waf_recovery_unavailable");
  assert.equal(nrAction.retryable, false);
  // MAX_RECOVERY_RETRIES stays 1 in the transport source itself: exactly two
  // create+completion legs (the original, and the single post-solve retry), no
  // attempt loop, and no unbounded loop.
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  assert.equal(
    (src.match(/= await createLeg\(/g) ?? []).length,
    2,
    "exactly two create legs: original + one post-solve retry",
  );
  assert.equal(
    (src.match(/= await completeLeg\(/g) ?? []).length,
    2,
    "exactly two completion attempts, never more",
  );
  assert.ok(!/for\s*\(.*attempt/.test(src), "no attempt loop in the transport");
  assert.ok(!/while\s*\(true\)/.test(src), "no unbounded loop in the transport");
  // The recovery is invoked at most once on the whole path.
  assert.equal((src.match(/recoverWithHumanCaptcha\(/g) ?? []).length, 1);
});

test("policy: auth failures are never converted into a WAF clearance retry", () => {
  const unauthorized = new RetryableQwenStreamError(
    "Qwen upstream error: Unauthorized: no permission",
    0,
  );
  unauthorized.upstreamCode = "Unauthorized";
  assert.equal(isDirectClearanceExhausted(unauthorized), false);
  const action = classifyRetryAction(unauthorized);
  assert.notEqual(action.reason, "direct_waf_clearance_timeout");
  // It must keep the pre-existing auth handling (account rotation + cooldown).
  assert.equal(action.switchAccount, true);
});

test("policy: a generic WAF challenge is NOT swept into the clearance retry", () => {
  // A raw upstream challenge the transport never recovered from: unchanged.
  const raw = new RetryableQwenStreamError("Qwen upstream error: RGV587", 0);
  raw.upstreamCode = "waf_challenge";
  assert.equal(isDirectClearanceExhausted(raw), false);
  const action = classifyRetryAction(raw);
  assert.notEqual(
    action.reason,
    "direct_waf_clearance_timeout",
    "a raw upstream challenge must not be relabelled as a transport clearance failure",
  );
  assert.equal(
    isDirectClearanceExhausted(raw),
    false,
    "only the transport's own typed error qualifies",
  );
});

test("policy: malformed/config failures never enter the clearance branch", () => {
  // These cases have their own pre-existing semantics (ModelNotFound is
  // deliberately retryable with account rotation upstream of this change).
  // What this change must guarantee is only that none of them is RELABELLED as
  // a direct WAF clearance failure.
  const unsupported = new DirectTransportUnsupported("no-bearer-token");
  assert.equal(isDirectClearanceExhausted(unsupported), false);
  assert.equal(isDirectWafRecoveryUnavailable(unsupported), false);
  assert.notEqual(
    classifyRetryAction(unsupported).reason,
    "direct_waf_clearance_timeout",
    "an out-of-scope request is never relabelled as a WAF clearance failure",
  );

  const notFound = new RetryableQwenStreamError("model_not_found", 0);
  notFound.upstreamCode = "ModelNotFound";
  assert.equal(isDirectClearanceExhausted(notFound), false);
  assert.notEqual(
    classifyRetryAction(notFound).reason,
    "direct_waf_clearance_timeout",
  );

  // A malformed/short non-SSE upstream answer is a WAF-shaped signal but not a
  // transport clearance failure; it keeps the generic WAF handling.
  const malformed = new RetryableQwenStreamError(
    "Qwen returned a non-SSE response before generation started.",
    0,
  );
  malformed.upstreamCode = "non_sse_response";
  assert.equal(isDirectClearanceExhausted(malformed), false);
  assert.notEqual(
    classifyRetryAction(malformed).reason,
    "direct_waf_clearance_timeout",
  );
});

test("policy: the predicate needs the exact typed error, not matching prose", () => {
  // A hand-rolled error that merely says the same thing must NOT qualify.
  const impostor = Object.assign(new Error("direct-transport-waf-clearance-timeout"), {
    name: "Error",
  });
  assert.equal(isDirectClearanceExhausted(impostor), false);
  // Nor may a spoofed name with the wrong reason slip through.
  const wrongReason = new DirectTransportWafBlocked(true, true);
  assert.equal(isDirectClearanceExhausted(wrongReason), false);
});

// ── no regression in the untouched paths ───────────────────────────────────

test("flag: false keeps the legacy transport and stays out of the WAF branch", () => {
  assert.equal(isDirectTransportEnabled(), false);
  const src = fs.readFileSync("src/routes/chat/retry-policy.ts", "utf-8");
  // The new branch must not reference the feature flag: classification is
  // driven by the concrete error, so flag=false can never route here.
  const branch = src.slice(
    src.indexOf("if (isDirectClearanceExhausted(err))"),
    src.indexOf("if (isAntiBotError(err))"),
  );
  assert.ok(!/directWebTransport|QWEN_DIRECT_WEB_TRANSPORT/.test(branch));
});

test("sse: the successful path is untouched by this change", () => {
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  // Still a raw passthrough of the upstream SSE, with no buffering rewrite.
  assert.ok(/stream: result\.stream/.test(src));
  assert.ok(!/extractAnswerFromSse\(raw\)/.test(src),
    "the transport must not rebuild the stream it forwards");
});
