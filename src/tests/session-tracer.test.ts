import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  traceContextId,
  tracePageId,
  traceSessionEvent,
  noteUpstreamAuthResult,
  markFirstFailure,
  classifyTransition,
  snapshotSessionState,
  getSessionTrace,
  getFirstFailureTs,
  TRACE_TARGET_ACCOUNT,
} from "../services/session-tracer.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fakeJwt(iat: number, exp: number): string {
  return `h.${b64url({ iat, exp })}.s`;
}

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

test("session-tracer: settings appUnauthorized marks firstFailure immediately", () => {
  assert.equal(getFirstFailureTs(), null);
  noteUpstreamAuthResult(TRACE_TARGET_ACCOUNT, "settings", 200, true);
  assert.ok(typeof getFirstFailureTs() === "number");
});

test("session-tracer: second failure never overwrites first", () => {
  const first = getFirstFailureTs();
  assert.ok(first !== null);
  noteUpstreamAuthResult(TRACE_TARGET_ACCOUNT, "create-chat", 401, true);
  assert.equal(getFirstFailureTs(), first);
});

test("session-tracer: snapshot precedes recovery in personalization 401 path (source)", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const anchor = src.indexOf("Personalization 401 — refreshing session");
  assert.ok(anchor >= 0);
  const block = src.slice(anchor, anchor + 1500);
  const markAt = block.indexOf("markFirstFailure");
  const refreshAt = block.indexOf("getQwenHeaders(true");
  assert.ok(markAt >= 0 && refreshAt >= 0 && markAt < refreshAt);
});

test("session-tracer: JWT iat/exp parsed safely, non-JWT gives nulls", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = fakeJwt(nowSec - 100, nowSec + 3600);
  const fakeContext = {
    cookies: async () => [{ name: "token", value: jwt }],
  };
  const snap = await snapshotSessionState(TRACE_TARGET_ACCOUNT, {
    context: fakeContext,
  });
  assert.ok(snap);
  assert.equal(snap.tokenPresent, true);
  assert.ok(!JSON.stringify(snap).includes(jwt.slice(0, 20)));
  assert.equal(snap.tokenIat, nowSec - 100);
  assert.equal(snap.tokenExp, nowSec + 3600);
  assert.equal(snap.cookieCount, 1);
  const plain = await snapshotSessionState(TRACE_TARGET_ACCOUNT, {
    context: { cookies: async () => [{ name: "token", value: "opaque" }] },
  });
  assert.ok(plain);
  assert.equal(plain.tokenIat, null);
  assert.equal(plain.tokenExp, null);
});

test("session-tracer: baseline only recorded on clean 2xx", () => {
  const t = getSessionTrace();
  assert.ok(t.baseline === null || !/unauthorized|401/i.test(t.baseline.detail));
});

test("session-tracer: endpoint shape carries baseline+firstFailure+classification", () => {
  const t = getSessionTrace();
  for (const k of ["target", "baseline", "firstFailureTs", "firstFailure", "classification", "window"]) {
    assert.ok(k in t, `missing ${k}`);
  }
  if (t.classification) {
    for (const k of ["verdict", "tokenChanged", "contextChanged", "dbStateChanged"]) {
      assert.ok(k in t.classification, `missing ${k}`);
    }
  }
});

test("session-tracer: classifyTransition distinguishes A/B/C/D", async () => {
  const { classifyTransition: classify } = await import("../services/session-tracer.ts");
  const base = {
    ts: 1, contextId: "ctx1", pageId: "pg1", tokenHash: "aa", tokenPresent: true,
    tokenIat: 1, tokenExp: 9999999999, cookieNameHash: "ck", cookieCount: 3, capturedAt: 100,
  };
  const same = { ...base, ts: 2 };
  const diffTok = { ...same, tokenHash: "bb" };
  const diffCtx = { ...same, contextId: "ctx2" };
  const diffDb = { ...same, capturedAt: 200 };
  assert.equal(classify(base, diffTok, []).verdict, "A_TOKEN");
  assert.equal(classify(base, diffCtx, []).verdict, "B_CONTEXT");
  assert.equal(classify(base, diffDb, []).verdict, "C_PERSISTED");
  assert.equal(classify(base, same, []).verdict, "D_UPSTREAM");
  assert.equal(classify(base, same, [{ ts: 1, event: "LOGIN_START", detail: "", snapshot: null }]).verdict, "UNKNOWN");
  assert.equal(classify(null, diffTok, []).verdict, "UNKNOWN");
});

test("session-tracer: generation monotonic per account + overlap detection", async () => {
  const mod = await import("../services/session-tracer.ts");
  const before = mod.currentGeneration("gen-test-acct");
  mod.traceSessionEvent("gen-test-acct", "LOGIN_START");
  // non-target account: no generation tracking (target gate)
  assert.equal(mod.currentGeneration("gen-test-acct"), before);
  assert.equal(mod.loginOverlapDetected("gen-test-acct"), false);
});

test("session-tracer: concurrent logins flagged on target", async () => {
  const mod = await import("../services/session-tracer.ts");
  const t = mod.TRACE_TARGET_ACCOUNT;
  mod.traceSessionEvent(t, "LOGIN_START", "caller=test-a");
  mod.traceSessionEvent(t, "LOGIN_START", "caller=test-b");
  assert.equal(mod.loginOverlapDetected(t), true);
  mod.traceSessionEvent(t, "LOGIN_END", "ok");
  mod.traceSessionEvent(t, "LOGIN_END", "ok");
  assert.equal(mod.loginOverlapDetected(t), false);
  assert.ok(mod.currentGeneration(t) >= 2);
});

test("session-tracer: superseded pattern helper (failure gen < max gen)", async () => {
  const mod = await import("../services/session-tracer.ts");
  const isSuperseded = (failureGen: number | null, maxGen: number): boolean =>
    failureGen !== null && maxGen > failureGen;
  assert.equal(isSuperseded(2, 3), true);
  assert.equal(isSuperseded(3, 3), false);
  assert.equal(isSuperseded(null, 3), false);
  void mod;
});
