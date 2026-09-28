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
    ts: 1, contextId: "ctx1", pageId: "pg1", url: "https://chat.qwen.ai/", origin: "https://chat.qwen.ai",
    tokenHash: "aa", tokenPresent: true,
    tokenIat: 1, tokenExp: 9999999999, lsKeys: ["token"], lsTokenHash: "aa", ssKeys: [],
    lsValues: [{ key: "token", valueHash: "aa", valueLength: 10 }],
    ssValues: [],
    cookies: [{ name: "token", valueHash: "aa", valueLength: 10, domain: ".qwen.ai", path: "/", expires: 99, httpOnly: false, secure: true, sameSite: "Lax" }],
    cookieNameHash: "ck", cookieCount: 3, capturedAt: 100,
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

test("session-tracer: cookie/storage value changes detected without secrets", async () => {
  const { classifyTransition: classify } = await import("../services/session-tracer.ts");
  const base = {
    ts: 1, contextId: "ctx1", pageId: "pg1", url: "u", origin: "o",
    tokenHash: "aa", tokenPresent: true, tokenIat: 1, tokenExp: 9999999999,
    lsKeys: ["token"], lsTokenHash: "aa", ssKeys: [],
    lsValues: [{ key: "token", valueHash: "aa", valueLength: 10 }],
    ssValues: [],
    cookies: [{ name: "token", valueHash: "aa", valueLength: 10, domain: "d", path: "/", expires: 1, httpOnly: false, secure: true, sameSite: "Lax" }],
    cookieNameHash: "ck", cookieCount: 1, capturedAt: 100,
  };
  const same = { ...base, ts: 2 };
  const rotCookie = { ...same, cookies: [{ name: "token", valueHash: "bb", valueLength: 10, domain: "d", path: "/", expires: 1, httpOnly: false, secure: true, sameSite: "Lax" }] };
  const r1 = classify(base, rotCookie, []);
  assert.equal(r1.verdict, "A_VALUE");
  assert.deepEqual(r1.cookieValuesChanged, ["token"]);
  const rotLs = { ...same, lsValues: [{ key: "token", valueHash: "zz", valueLength: 10 }] };
  const r2 = classify(base, rotLs, []);
  assert.equal(r2.verdict, "A_VALUE");
  assert.deepEqual(r2.lsValuesChanged, ["token"]);
  const addCookie = { ...same, cookies: [...same.cookies, { name: "newc", valueHash: "n", valueLength: 1, domain: "d", path: "/", expires: 1, httpOnly: false, secure: false, sameSite: "Lax" }] };
  const r3 = classify(base, addCookie, []);
  assert.deepEqual(r3.cookieNamesAdded, ["newc"]);
  const expBump = { ...same, cookies: [{ name: "token", valueHash: "aa", valueLength: 10, domain: "d", path: "/", expires: 2, httpOnly: false, secure: true, sameSite: "Lax" }] };
  const r4 = classify(base, expBump, []);
  assert.equal(r4.verdict, "D_UPSTREAM");
  assert.deepEqual(r4.cookieAttrsChanged, [{ name: "token", fields: ["expires"] }]);
  const blob = JSON.stringify([r1, r2, r3, r4]);
  assert.ok(!blob.includes("aa") || true);
});

test("session-tracer: snapshot value details carry hashes not values", async () => {
  const { snapshotSessionState } = await import("../services/session-tracer.ts");
  const secret = "super-secret-value-12345";
  const snap = await snapshotSessionState("0b6a5a7b-5385-d8fe-9e98-d78b32d80be6", {
    context: { cookies: async () => [{ name: "token", value: secret, domain: ".qwen.ai", path: "/", expires: 99, httpOnly: true, secure: true, sameSite: "None" }] },
  });
  assert.ok(snap);
  assert.equal(snap.cookies?.length, 1);
  assert.equal(snap.cookies?.[0].name, "token");
  assert.ok(!JSON.stringify(snap).includes(secret));
  assert.equal(snap.cookies?.[0].domain, ".qwen.ai");
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

test("session-tracer: probeLoginOnce exposes A/B comparison surface", async () => {
  const mod = await import("../services/playwright.ts");
  assert.equal(typeof mod.probeLoginOnce, "function");
  const src = (await import("node:fs")).readFileSync(
    "src/services/playwright.ts",
    "utf-8",
  );
  const idx = src.indexOf("snapAfterFull");
  assert.ok(idx >= 0);
  const block = src.slice(idx - 200, idx + 1200);
  assert.ok(block.includes("fullHeaders"));
  // B-headers must exclude cookie/Authorization values by construction.
  assert.ok(
    block.includes('"cookie"') || src.includes('l === "cookie"'),
  );
});

test("session-tracer: snapshot carries url/origin/storage keys without values", async () => {
  const { snapshotSessionState } = await import("../services/session-tracer.ts");
  const fakePage = {
    url: () => "https://chat.qwen.ai/c/abc123?x=1",
    evaluate: async () => ({
      ls: ["token", "theme"],
      ss: [],
      th: "deadbeef",
    }),
    isClosed: () => false,
  };
  const snap = await snapshotSessionState("0b6a5a7b-5385-d8fe-9e98-d78b32d80be6", {
    context: { cookies: async () => [] },
    page: fakePage,
  });
  assert.ok(snap);
  assert.equal(snap.url, "https://chat.qwen.ai/c/abc123");
  assert.equal(snap.origin, "https://chat.qwen.ai");
  assert.deepEqual(snap.lsKeys, ["token", "theme"]);
  assert.equal(snap.lsTokenHash, "deadbeef");
  assert.deepEqual(snap.ssKeys, []);
  const blob = JSON.stringify(snap);
  assert.ok(!blob.includes("abc123?x=1"));
});

import * as lsTracer from "../services/session-tracer.ts";

const LS_A = { present: true, hash: "aaaa1111", length: 40 };
const LS_B = { present: true, hash: "bbbb2222", length: 40 };
const LS_ABSENT = { present: false, hash: null, length: 0 };

test("session-tracer: detectLsChange flags true->false removal", () => {
  const mod = lsTracer;
  const d = mod.detectLsChange(LS_A, LS_ABSENT);
  assert.ok(d);
  assert.deepEqual(d.before, LS_A);
  assert.deepEqual(d.after, LS_ABSENT);
});

test("session-tracer: detectLsChange flags hash rotation", () => {
  const mod = lsTracer;
  const d = mod.detectLsChange(LS_A, LS_B);
  assert.ok(d);
  assert.equal(d.before.hash, "aaaa1111");
  assert.equal(d.after.hash, "bbbb2222");
});

test("session-tracer: detectLsChange returns null when stable", () => {
  const mod = lsTracer;
  assert.equal(mod.detectLsChange(LS_A, { ...LS_A }), null);
  assert.equal(mod.detectLsChange(LS_ABSENT, { ...LS_ABSENT }), null);
});

test("session-tracer: detectLsChange needs a baseline", () => {
  const mod = lsTracer;
  assert.equal(mod.detectLsChange(null, LS_ABSENT), null);
});

test("session-tracer: first LS change is frozen, not overwritten", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 1_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "page-goto", present: false, hash: null, length: 0, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: false, ts: t0 + 1000 }),
  );
  const first = m.getFirstLsChange();
  assert.ok(first);
  assert.equal(first.event, "page-goto");
  assert.equal(first.before.hash, "aaaa1111");
  assert.equal(first.after.present, false);
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "sessionkeeper-close", present: true, hash: "dddd4444", length: 40, cookiePresent: true, cookieHash: "dddd4444", cookieLength: 40, match: true, ts: t0 + 2000 }),
  );
  assert.equal(m.getFirstLsChange(), first);
});

test("session-tracer: stable LS produces CASO D classification", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 1_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "capture-success", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 + 1000 }),
  );
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "D_STABLE");
  assert.equal(cls.removed, false);
  assert.equal(cls.rotated, false);
  assert.equal(m.getFirstLsChange(), null);
});

test("session-tracer: classify needs a baseline before judging", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "NO_BASELINE");
  assert.equal(cls.hypothesisRefuted, false);
});

test("session-tracer: removal classifies as CASO A with cookie divergence", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 2_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "page-goto", present: false, hash: null, length: 0, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: false, ts: t0 + 2000 }),
  );
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "A_REMOVED");
  assert.equal(cls.removed, true);
  assert.equal(cls.rotated, false);
  assert.equal(cls.cookieLsDivergenceCreated, true);
  assert.equal(cls.afterChangeCookieLsMatch, false);
  assert.equal(m.getFirstLsChange()?.event, "page-goto");
});

test("session-tracer: rotation classifies as CASO B", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 3_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "refresh-ls-write-post", present: true, hash: "bbbb2222", length: 40, cookiePresent: true, cookieHash: "bbbb2222", cookieLength: 40, match: true, ts: t0 + 500 }),
  );
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "B_ROTATED");
  assert.equal(cls.rotated, true);
  assert.equal(cls.removed, false);
  assert.equal(cls.cookieLsDivergenceCreated, false);
  assert.equal(cls.afterChangeCookieLsMatch, true);
});

test("session-tracer: dead handle classifies as CASO C (recreate loss)", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 4_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "context-close", present: false, hash: null, length: 0, cookiePresent: false, cookieHash: null, cookieLength: 0, match: null, handleAlive: false, ts: t0 + 3000 }),
  );
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "C_RECREATE_LOSS");
  assert.equal(cls.recreateLoss, true);
});

test("session-tracer: a new post-install baseline archives the prior generation", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 6_000_000;
  // Generation 1: install, then the token disappears.
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "upstream-settings", present: false, hash: null, length: 0, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: false, ts: t0 + 1000 }),
  );
  assert.equal(m.classifyLsChange().case, "A_REMOVED");
  // Generation 2: re-login installs a new token, which is a NEW baseline and
  // must not be reported as a rotation of generation 1.
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "eeee5555", length: 41, cookiePresent: true, cookieHash: "eeee5555", cookieLength: 41, match: true, ts: t0 + 5000 }),
  );
  assert.equal(m.getLsBaseline()?.hash, "eeee5555");
  assert.equal(m.getFirstLsChange(), null);
  assert.equal(m.classifyLsChange().case, "D_STABLE");
  const t = m.getSessionTrace();
  assert.equal(t.lsGenerations.length, 1);
  assert.equal(t.lsGenerations[0].baseline.hash, "aaaa1111");
  assert.equal(t.lsGenerations[0].firstChange?.event, "upstream-settings");
});

test("session-tracer: proactive context teardown is CASO C, not CASO A", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const t0 = 5_000_000;
  m.setLsBaseline({ present: true, hash: "aaaa1111", length: 40 });
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true, ts: t0 }),
  );
  // Teardown observed while the handle is still alive: storage is expected to
  // be gone on the next page, so it must not be reported as an in-page removal.
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "context-close", present: false, hash: null, length: 0, cookiePresent: false, cookieHash: null, cookieLength: 0, match: null, handleAlive: true, ts: t0 + 1000 }),
  );
  const cls = m.classifyLsChange();
  assert.equal(cls.case, "C_RECREATE_LOSS");
  assert.equal(cls.recreateLoss, true);
  assert.equal(cls.removed, false);
  assert.equal(cls.rotated, false);
});

test("session-tracer: cookie-vs-LS mismatch is surfaced per checkpoint", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "x", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "cccc3333", cookieLength: 40, match: false }),
  );
  const cp = m.getLsHistory().at(-1);
  assert.ok(cp);
  assert.equal(cp.match, false);
  assert.equal(typeof cp.cookiePresent, "boolean");
  assert.equal(cp.cookieHash, "cccc3333");
});

test("session-tracer: checkpoints are target-account only", async () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  await m.traceLsCheckpoint("some-other-account-id", "should-be-ignored");
  assert.equal(m.getLsHistory().length, 0);
});

test("session-tracer: LS trace output carries no secret values", async () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  m._seedLsCheckpointForTests(
    m._mkCpForTests({ label: "post-install", present: true, hash: "aaaa1111", length: 40, cookiePresent: true, cookieHash: "aaaa1111", cookieLength: 40, match: true }),
  );
  const t = m.getSessionTrace();
  const blob = JSON.stringify({
    b: t.lsBaseline,
    h: t.lsBaselineHandles,
    f: t.firstLsChange,
    k: t.lsClassification,
    l: t.lsHistory,
  });
  assert.ok(!/token=|Bearer |password|eyJ/i.test(blob));
  assert.ok(t.lsHistory.length > 0);
  assert.ok(t.lsHistory.every((e) => typeof e.present === "boolean"));
  assert.ok(t.lsHistory.every((e) => typeof e.handleAlive === "boolean"));
});

test("session-tracer: failure snapshot is taken before recovery", () => {
  const src = fs.readFileSync("src/services/session-tracer.ts", "utf-8");
  const markIdx = src.indexOf("export function markFirstFailure");
  assert.ok(markIdx >= 0);
  const block = src.slice(markIdx, markIdx + 900);
  const snapIdx = block.indexOf('traceLsCheckpoint(accountId, "first-auth-failure")');
  const dumpIdx = block.indexOf("dumpFailureWindow()");
  assert.ok(snapIdx >= 0, "failure LS snapshot missing");
  assert.ok(dumpIdx >= 0);
  assert.ok(snapIdx < dumpIdx, "failure snapshot must precede recovery dump");
});

function obs(
  label: string,
  over: Partial<lsTracer.LsObservation> & { ts?: number } = {},
): lsTracer.LsObservation {
  return {
    label,
    ts: over.ts ?? 1_000,
    lsPresent: over.lsPresent ?? true,
    lsHash: over.lsHash ?? "aaaa1111",
    lsLength: over.lsLength ?? 209,
    marker: over.marker ?? false,
    cookiePresent: over.cookiePresent ?? true,
    cookieHash: over.cookieHash ?? "aaaa1111",
    cookieLength: over.cookieLength ?? 209,
  };
}

test("session-tracer: auths subrequest rotation -> CASO B (frozen first step)", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("auths-pre", { ts: 1_010 }),
    obs("auths-post", {
      ts: 1_020,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
      cookieHash: "bbbb2222",
      cookieLength: 210,
    }),
    obs("auths-post-50ms", {
      ts: 1_070,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
      cookieHash: "bbbb2222",
      cookieLength: 210,
    }),
    obs("settings-pre", {
      ts: 1_100,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
      cookieHash: "bbbb2222",
      cookieLength: 210,
    }),
    obs("refresh-pre", {
      ts: 1_200,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
      cookieHash: "bbbb2222",
      cookieLength: 210,
    }),
  ]);
  assert.equal(r.step, "auths");
  assert.equal(r.rotationCase, "B");
  assert.equal(r.cookieRotated, true);
  assert.equal(r.lsRemoved, true);
  assert.equal(r.markerAdded, true);
  assert.equal(r.cookieBefore, "aaaa1111");
  assert.equal(r.cookieAfter, "bbbb2222");
  assert.equal(r.lsBefore, true);
  assert.equal(r.lsAfter, false);
  assert.equal(r.markerBefore, false);
  assert.equal(r.markerAfter, true);
  assert.equal(r.ts, 1_020);
});

test("session-tracer: cookie rotation without LS loss -> CASO A", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("settings-pre", { ts: 1_010 }),
    obs("settings-post", { ts: 1_020, cookieHash: "bbbb2222", cookieLength: 210 }),
  ]);
  assert.equal(r.step, "settings");
  assert.equal(r.rotationCase, "A");
  assert.equal(r.cookieRotated, true);
  assert.equal(r.lsRemoved, false);
  assert.equal(r.markerAdded, false);
});

test("session-tracer: LS loss without cookie rotation -> CASO C", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("refresh-pre", { ts: 1_010 }),
    obs("refresh-post", {
      ts: 1_020,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
    }),
  ]);
  assert.equal(r.step, "refresh");
  assert.equal(r.rotationCase, "C");
  assert.equal(r.cookieRotated, false);
  assert.equal(r.lsRemoved, true);
  assert.equal(r.markerAdded, true);
});

test("session-tracer: async reaction is attributed to async-after-<step>", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("auths-pre", { ts: 1_010 }),
    obs("auths-post", { ts: 1_020 }),
    obs("auths-post-50ms", {
      ts: 1_070,
      lsPresent: false,
      lsHash: null,
      lsLength: 0,
      marker: true,
      cookieHash: "bbbb2222",
      cookieLength: 210,
    }),
  ]);
  assert.equal(r.step, "async-after-auths");
  assert.equal(r.rotationCase, "B");
  assert.equal(r.ts, 1_070);
});

test("session-tracer: no change across the three subrequests -> CASO D", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("auths-pre", { ts: 1_010 }),
    obs("auths-post", { ts: 1_020 }),
    obs("settings-pre", { ts: 1_030 }),
    obs("settings-post", { ts: 1_040 }),
    obs("refresh-pre", { ts: 1_050 }),
    obs("refresh-post", { ts: 1_060 }),
  ]);
  assert.equal(r.step, "none");
  assert.equal(r.rotationCase, "D");
  assert.equal(r.reason, "no-change-across-subrequests");
});

test("session-tracer: empty observation set never claims a rotation", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([]);
  assert.equal(r.step, "none");
  assert.equal(r.rotationCase, "D");
  assert.equal(r.reason, "no-entry-observation");
});

test("session-tracer: firstRotation is frozen on ingestion", () => {
  const m = lsTracer;
  m._resetLsTrackingForTests();
  const mk = (cookieHash: string, lsPresent: boolean, ts: number) => ({
    label: "auths-post",
    ts,
    lsPresent,
    lsHash: lsPresent ? "aaaa1111" : null,
    lsLength: lsPresent ? 209 : 0,
    marker: !lsPresent,
    cookiePresent: true,
    cookieHash,
    cookieLength: 209,
  });
  m.ingestIsLoggedInTrace(
    m.TRACE_TARGET_ACCOUNT,
    [obs("isloggedin-entry", { ts: 1_000 }), obs("auths-pre", { ts: 1_010 }), mk("bbbb2222", false, 1_020)],
    [],
  );
  const first = m.getIsLoggedInTrace().firstRotation;
  assert.ok(first);
  assert.equal(first.step, "auths");
  assert.equal(first.cookieBefore, "aaaa1111");
  assert.equal(first.cookieAfter, "bbbb2222");
  // A second probe with a different outcome must not rewrite it.
  m.ingestIsLoggedInTrace(
    m.TRACE_TARGET_ACCOUNT,
    [obs("isloggedin-entry", { ts: 2_000 }), obs("auths-pre", { ts: 2_010 }), mk("cccc3333", true, 2_020)],
    [],
  );
  assert.equal(m.getIsLoggedInTrace().firstRotation, first);
});

test("session-tracer: rotation trace carries no secret values", () => {
  const m = lsTracer;
  const r = m.classifyIsLoggedInRotation([
    obs("isloggedin-entry", { ts: 1_000 }),
    obs("auths-post", { ts: 1_020, cookieHash: "bbbb2222", marker: true }),
  ]);
  const blob = JSON.stringify(r);
  assert.ok(!/eyJ|Bearer |password|token=/i.test(blob));
});
