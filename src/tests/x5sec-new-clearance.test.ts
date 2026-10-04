/**
 * The recovery must not report success on the very clearance that was refused.
 *
 * Production regression: createDirectAccountStream invalidated the clearance
 * (which cleared x5secHash) and then compared against that already-invalidated
 * value, so ANY x5sec still in the jar satisfied "solved". Recovery reported
 * success in ~2.8s against the unchanged rejected cookie, retried, got RGV587
 * again, and the retry-policy rotated accounts in a loop until the client timed
 * out. A second symptom came from reading a relative `expires` as an epoch,
 * which reported a ~365-day TTL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  X5SEC_COOKIE_NAME,
  captureX5secBaseline,
  isNewClearance,
  isX5secExpired,
  normalizeCookieExpiryMs,
  parseX5secFromCookies,
  _resetAccountSessionsForTests,
} from "../services/qwen-account-session.ts";

// ── T1..T4, T9 the real "new clearance" criterion ──────────────────────────

const ok = { present: true, valid: true, hash: "newhash" };
const NONE = { present: false, hash: null, expiresAt: 0 };

test("T1 no previous clearance -> a valid one counts as solved", () => {
  assert.equal(isNewClearance(NONE, ok), true);
});

test("T2 previous present, same cookie still there -> NOT solved", () => {
  const b = { present: true, hash: "same", expiresAt: Date.now() + 60_000 };
  assert.equal(isNewClearance(b, { present: true, valid: true, hash: "same" }), false);
});

test("T3 previous present, disappears and returns with the same value -> NOT solved", () => {
  const b = { present: true, hash: "same", expiresAt: Date.now() + 60_000 };
  // gone, then back with the identical value: still not a solve.
  assert.equal(isNewClearance(b, { present: false, valid: false, hash: null }), false);
  assert.equal(isNewClearance(b, { present: true, valid: true, hash: "same" }), false);
});

test("T4 previous present, a different hash -> solved", () => {
  const b = { present: true, hash: "old", expiresAt: Date.now() + 60_000 };
  assert.equal(isNewClearance(b, { present: true, valid: true, hash: "new" }), true);
});

test("T8 an expired observation is never a solve", () => {
  assert.equal(isNewClearance(NONE, { present: true, valid: false, hash: "h" }), false);
  const b = { present: true, hash: "old", expiresAt: Date.now() + 1000 };
  assert.equal(isNewClearance(b, { present: true, valid: false, hash: "new" }), false,
    "a different but expired cookie does not clear the challenge");
});

test("T9 a new cookie counts even while the old one was still cached", () => {
  const b = { present: true, hash: "old", expiresAt: Date.now() + 60_000 };
  assert.equal(isNewClearance(b, ok), true);
});

// ── T5 the baseline survives invalidation ──────────────────────────────────

test("T5 the baseline is captured before, and outlives, invalidation", async () => {
  _resetAccountSessionsForTests();
  const { captureAccountSessionFromPage, invalidateX5sec, peekAccountSession } = await import(
    "../services/qwen-account-session.ts"
  );
  const page = {
    context: () => ({
      cookies: async () => [
        { name: "cna", value: "x", domain: ".qwen.ai", path: "/", expires: -1 },
        { name: X5SEC_COOKIE_NAME, value: "rejected", domain: "chat.qwen.ai",
          path: "/", expires: Math.floor(Date.now() / 1000) + 900 },
      ],
    }),
    evaluate: async () => ({ token: "", userAgent: "Mozilla/5.0 Chrome/153" }),
  } as unknown as Parameters<typeof captureAccountSessionFromPage>[1];

  const state = await captureAccountSessionFromPage("acct-t5", page);
  const baseline = captureX5secBaseline(state);
  assert.equal(baseline.present, true);
  assert.ok(baseline.hash, "the baseline must carry the rejected cookie's fingerprint");

  // The operational cache is cleared…
  invalidateX5sec("acct-t5");
  const after = peekAccountSession("acct-t5");
  assert.equal(after?.x5secHash, null, "cache is cleared");
  // …but the baseline still identifies the rejected cookie.
  assert.equal(baseline.hash !== null, true);
  assert.equal(
    isNewClearance(baseline, { present: true, valid: true, hash: baseline.hash }),
    false,
    "the same cookie after invalidation must NOT be a solve",
  );
  _resetAccountSessionsForTests();
});

// ── T6 / T7 expires normalisation ──────────────────────────────────────────

test("T6 expires in epoch seconds -> correct ttl", () => {
  const now = 1_000_000_000_000;
  const expS = (now + 60_000) / 1000;
  assert.equal(normalizeCookieExpiryMs(expS, now), expS * 1000);
  const p = parseX5secFromCookies(
    [{ name: X5SEC_COOKIE_NAME, expires: expS, value: "v" }], now,
  );
  assert.equal(p.valid, true);
  assert.equal(p.expiresAt - now, 60_000, "ttl must be 60s, not 60000s");
});

test("T7 expires already in epoch milliseconds -> no double multiplication", () => {
  const now = 1_000_000_000_000;
  const expMs = now + 60_000;
  assert.equal(normalizeCookieExpiryMs(expMs, now), expMs, "must be returned untouched");
  const p = parseX5secFromCookies(
    [{ name: X5SEC_COOKIE_NAME, expires: expMs, value: "v" }], now,
  );
  assert.equal(p.valid, true);
  assert.equal(p.expiresAt - now, 60_000);
  // The production symptom: a RELATIVE duration read as an epoch.
  const relative = normalizeCookieExpiryMs(31_535_954, now);
  assert.equal(relative, now + 31_535_954 * 1000, "a duration is anchored to now");
  const absurd = parseX5secFromCookies(
    [{ name: X5SEC_COOKIE_NAME, expires: 31_535_954, value: "v" }], now,
  );
  // Anchored, not 1970: a sane remaining TTL, never ~365 days from 1970.
  assert.equal(absurd.expiresAt - now, 31_535_954 * 1000);
  assert.ok(absurd.valid, "a future relative duration is still a valid clearance");
});

test("expiry: a session cookie has no usable expiry", () => {
  const now = 1_000_000_000_000;
  assert.equal(normalizeCookieExpiryMs(-1, now), null);
  assert.equal(normalizeCookieExpiryMs(0, now), null);
  assert.equal(normalizeCookieExpiryMs(undefined, now), null);
  assert.equal(parseX5secFromCookies([{ name: X5SEC_COOKIE_NAME, expires: -1 }], now).valid, false);
  assert.equal(isX5secExpired({ x5secPresent: true, x5secExpiresAt: 0 }, now), true);
});

// ── the wait actually uses the baseline ───────────────────────────────────

test("the human-solve wait requires a different clearance than the baseline", () => {
  const src = fs.readFileSync("src/services/qwen-human-captcha.ts", "utf-8");
  assert.ok(/baseline\??:\s*X5secBaseline/.test(src), "the wait takes a baseline");
  assert.ok(
    /isNewClearance\(baseline,\s*\{/.test(src.replace(/\s+/g, " ")),
    "solved must go through isNewClearance",
  );
  // The old, too-weak criterion must be gone.
  assert.ok(!/snap\.valid && snap\.hash !== lastSeen/.test(src), "old criterion removed");
  // No global baseline state.
  assert.ok(!/^let baseline/m.test(src), "the baseline is not global state");
});

test("the caller snapshots the rejected clearance before invalidating it", () => {
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  // Scoped to the HUMAN branch (headless Fix E invalidates without a
  // baseline/waiter by design): the baseline MUST be captured before the
  // invalidation that precedes the human recovery call.
  const humanAt = src.indexOf("opts.onCaptchaStart?.(");
  assert.ok(humanAt > 0, "human branch present");
  const region = src.slice(humanAt, humanAt + 2500);
  const capAt = region.indexOf("captureX5secBaseline(peekAccountSession(");
  const invAt = region.indexOf("invalidateX5sec(opts.accountId)");
  assert.ok(capAt > 0 && invAt > 0, "both must exist in the human branch");
  assert.ok(capAt < invAt, "the baseline MUST be captured before invalidation");
  // …and forwarded into the recovery.
  const after = region.slice(invAt, invAt + 700);
  assert.ok(/baseline,/.test(after), "the baseline must be passed to recovery");
});

// ── T10..T15 nothing else moved ────────────────────────────────────────────

test("T10/T11 recovery is still exactly one attempt on a brand new chat", () => {
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  assert.equal((src.match(/= await createLeg\(/g) ?? []).length, 2, "two legs");
  assert.equal((src.match(/= await completeLeg\(/g) ?? []).length, 2, "two completions");
  // The import is of the module; only the call names the function. Exactly one
  // recovery invocation remains.
  assert.equal((src.match(/recoverWithHumanCaptcha\(/g) ?? []).length, 1,
    "recovery is invoked exactly once");
  // The post-solve leg reassigns chatId to a brand new chat; the first leg's id
  // is never reused.
  assert.ok(/let chatId = await createLeg\(cookie\);/.test(src), "leg 1 creates a chat");
  assert.ok(/chatId = await createLeg\(cookie\);/.test(src), "recovery creates a NEW chat");
});

test("T12 a clearance timeout is still classified retryable", async () => {
  const { classifyRetryAction, isDirectClearanceExhausted } = await import(
    "../routes/chat/retry-policy.ts"
  );
  const { DirectTransportWafBlocked } = await import("../services/qwen-direct-stream.ts");
  const err = new DirectTransportWafBlocked(true, false, "clearance-timeout");
  assert.equal(isDirectClearanceExhausted(err), true);
  const action = classifyRetryAction(err);
  assert.equal(action.retryable, true);
  assert.equal(action.reason, "direct_waf_clearance_timeout");
});

test("T13 create-chat still omits the version header", () => {
  const src = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  assert.equal((src.match(/omitVersion: true/g) ?? []).length, 1);
  assert.ok(/rejected by \/chats\/new when stale/.test(src), "rationale kept");
});

test("T14 the DB-first bearer precedence is untouched", () => {
  const src = fs.readFileSync("src/services/qwen-account-session.ts", "utf-8");
  const at = src.indexOf("const bearerToken =");
  assert.ok(
    /dbToken\s*\|\|\s*lsToken\s*\|\|\s*cookieToken/.test(src.slice(at, src.indexOf("\n", at))),
  );
});

test("T15 the SSE contract and the legacy path are untouched", () => {
  const dt = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  assert.ok(/response\.output_text\.delta/.test(dt), "response.* events still handled");
  assert.ok(/DONE_EVENT_NAMES/.test(dt));
  assert.ok(fs.readFileSync("src/services/playwright.ts", "utf-8").includes("captureQwenHeaders"));
  const cfg = fs.readFileSync("src/core/config.ts", "utf-8");
  assert.ok(/QWEN_DIRECT_WEB_TRANSPORT: z\.string\(\)\.default\("false"\)/.test(cfg));
});
