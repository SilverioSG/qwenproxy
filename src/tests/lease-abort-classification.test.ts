import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
delete process.env.API_KEY;

import { classifyRetryAction } from "../routes/chat/retry-policy.ts";
import { classifyError } from "../api/error-classifier.ts";
import {
  ClientAbortedError,
  UpstreamRateLimit,
  isKnownClientAbortMessage,
} from "../core/errors.ts";

// FIX 1: "Aborted before acquiring account lease" (account-concurrency.ts:277,
// rejected only on an already-aborted signal) must classify as client_abort /
// HTTP 499 — never as a 500 backend failure.

test("lease abort (pre-lease) -> client_abort, no retry", () => {
  const action = classifyRetryAction(
    new Error("Aborted before acquiring account lease"),
  );
  assert.equal(action.reason, "client_abort");
  assert.equal(action.retryable, false);
  assert.equal(action.switchAccount, false);
});

test("lease abort (pre-lease) -> HTTP 499 ClientAbortedError", () => {
  const classified = classifyError(
    new Error("Aborted before acquiring account lease"),
  );
  assert.ok(classified instanceof ClientAbortedError);
  assert.equal(classified.statusCode, 499);
});

test("lease abort (queued wait) -> client_abort / 499", () => {
  const action = classifyRetryAction(
    new Error("Aborted while waiting for account lease"),
  );
  assert.equal(action.reason, "client_abort");
  assert.equal(action.retryable, false);
  const classified = classifyError(
    new Error("Aborted while waiting for account lease"),
  );
  assert.ok(classified instanceof ClientAbortedError);
  assert.equal(classified.statusCode, 499);
});

test("client disconnected before stream completed -> still client_abort", () => {
  const action = classifyRetryAction(
    new Error("client disconnected before stream completed"),
  );
  assert.equal(action.reason, "client_abort");
  assert.equal(action.retryable, false);
  const classified = classifyError(
    new Error("client disconnected before stream completed"),
  );
  assert.ok(classified instanceof ClientAbortedError);
  assert.equal(classified.statusCode, 499);
});

test("client aborted before stream creation -> still client_abort", () => {
  const action = classifyRetryAction(
    new Error("client aborted before stream creation"),
  );
  assert.equal(action.reason, "client_abort");
  const classified = classifyError(
    new Error("client aborted before stream creation"),
  );
  assert.ok(classified instanceof ClientAbortedError);
  assert.equal(classified.statusCode, 499);
});

test("real lease/busy failure is NOT a client abort", () => {
  const busy = new Error(
    "Account abc busy: timed out after 30000ms waiting for a free slot",
  );
  (busy as Error & { code?: string }).code = "account_busy";
  assert.equal(isKnownClientAbortMessage(busy.message), false);
  const action = classifyRetryAction(busy);
  assert.notEqual(action.reason, "client_abort");
  assert.equal(action.retryable, true);
  const classified = classifyError(busy);
  assert.ok(!(classified instanceof ClientAbortedError));
  assert.ok(classified instanceof UpstreamRateLimit);
  assert.equal(classified.statusCode, 429);
});

test("unrelated error containing 'lease' is NOT a client abort", () => {
  const err = new Error("failed to release account lease: slot corrupted");
  assert.equal(isKnownClientAbortMessage(err.message), false);
  const action = classifyRetryAction(err);
  assert.notEqual(action.reason, "client_abort");
  const classified = classifyError(err);
  assert.ok(!(classified instanceof ClientAbortedError));
});
