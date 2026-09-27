import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  traceContextId,
  tracePageId,
  traceSessionEvent,
  noteUpstreamAuthResult,
  getSessionTrace,
  getFirstFailureTs,
  TRACE_TARGET_ACCOUNT,
} from "../services/session-tracer.ts";

test("session-tracer: stable ids per object, distinct across objects", () => {
  const a = {};
  const b = {};
  assert.equal(traceContextId(a), traceContextId(a));
  assert.notEqual(traceContextId(a), traceContextId(b));
  assert.equal(tracePageId(a), tracePageId(a));
  assert.equal(traceContextId(null), null);
});

test("session-tracer: non-target accounts are ignored", () => {
  const before = getSessionTrace().window.length;
  traceSessionEvent("other-account", "LOGIN_START");
  noteUpstreamAuthResult("other-account", "settings", 401, true);
  assert.equal(getSessionTrace().window.length, before);
});

test("session-tracer: status payload carries no secrets", () => {
  traceSessionEvent(TRACE_TARGET_ACCOUNT, "LOGIN_START");
  noteUpstreamAuthResult(TRACE_TARGET_ACCOUNT, "settings", 200, false);
  const t = getSessionTrace();
  const blob = JSON.stringify(t);
  assert.ok(!/token=|Bearer |password|cookie=/i.test(blob));
  assert.ok(t.target === TRACE_TARGET_ACCOUNT);
});

test("session-tracer: hooks wired in hot paths (source check)", () => {
  const pw = fs.readFileSync("src/services/playwright.ts", "utf-8");
  for (const marker of [
    '"LOGIN_START"',
    '"LOGIN_END"',
    '"REAUTH_START"',
    '"CONTEXT_CLOSE"',
    '"CONTEXT_CREATE"',
    '"SESSIONKEEPER_CLOSE"',
    '"CAPTURE_START"',
    '"CAPTURE_END"',
  ]) {
    assert.ok(pw.includes(marker), `playwright.ts missing ${marker}`);
  }
  const qwen = fs.readFileSync("src/services/qwen.ts", "utf-8");
  assert.ok(qwen.includes("noteUpstreamAuthResult"));
  const pool = fs.readFileSync("src/services/qwen-chat-pool.ts", "utf-8");
  assert.ok(pool.includes("noteUpstreamAuthResult"));
  const db = fs.readFileSync("src/core/database.ts", "utf-8");
  assert.ok(db.includes("DB_SESSION_WRITE") && db.includes("DB_SESSION_READ"));
});

test("session-tracer: log lines carry no secret values", () => {
  const src = fs.readFileSync("src/services/session-tracer.ts", "utf-8");
  assert.ok(!/console\.log\(`[^`]*\$\{(token|cookie|password|bearer)/i.test(src));
  void getFirstFailureTs;
});
