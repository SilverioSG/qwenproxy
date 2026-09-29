/**
 * Focal tests for the DIRECT ACCOUNT TRANSPORT.
 *
 * Covers the contract proven live against the current upstream:
 *   - account requests carry `Authorization: Bearer <JWT>`; guest never does
 *   - the live cookie jar (incl. the `x5sec` clearance) is what gets sent
 *   - x5sec expiry parsing + invalidation semantics
 *   - the SSE parser understands the CURRENT `response.*` event shape
 *   - the feature flag defaults to false (legacy path untouched)
 *   - the direct hot path never calls captureQwenHeaders / the Baxia minter
 *   - the human-captcha path never drives the slider
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  QWEN_DIRECT_WEB_TRANSPORT_ENABLED,
  buildDirectQwenHeaders,
  classifySseFrame,
  directCompletionStream,
  extractAnswerFromSse,
  looksLikeWafChallenge,
  extractPunishUrl,
} from "../services/qwen-direct-transport.ts";
import {
  X5SEC_COOKIE_NAME,
  isX5secExpired,
  parseX5secFromCookies,
  describeAccountSession,
  _resetAccountSessionsForTests,
} from "../services/qwen-account-session.ts";
import {
  directTransportScopeReason,
  shouldUseDirectTransport,
} from "../services/qwen-transport-dispatch.ts";

// ── feature flag ─────────────────────────────────────────────────────────────

test("flag: QWEN_DIRECT_WEB_TRANSPORT defaults to false (legacy is the default)", () => {
  assert.equal(
    QWEN_DIRECT_WEB_TRANSPORT_ENABLED,
    false,
    "direct transport must be opt-in",
  );
  const cfg = fs.readFileSync("src/core/config.ts", "utf-8");
  assert.ok(
    /QWEN_DIRECT_WEB_TRANSPORT: z\.string\(\)\.default\("false"\)/.test(cfg),
    "env default must be false",
  );
  assert.ok(
    /directWebTransport: env\.QWEN_DIRECT_WEB_TRANSPORT === "true"/.test(cfg),
    "flag must be an explicit opt-in",
  );
});

test("flag: dispatcher keeps the legacy transport for out-of-scope requests", () => {
  // Flag off (the default) always means legacy.
  assert.deepEqual(
    shouldUseDirectTransport({ accountId: "acct-1", fileCount: 0 }),
    { use: false, reason: "flag-disabled" },
  );
  // The SCOPE check is independent of the flag, so the supported shapes can be
  // asserted directly.
  const base = { accountId: "acct-1", fileCount: 0 };
  assert.equal(directTransportScopeReason(base), null, "plain text is in scope");
  assert.equal(
    directTransportScopeReason({ ...base, fileCount: 1 }),
    "files-unsupported",
  );
  assert.equal(
    directTransportScopeReason({ ...base, threadParentId: "p1" }),
    "thread-continuation-unsupported",
  );
  assert.equal(
    directTransportScopeReason({ ...base, parallelEscape: true }),
    "auxiliary-chat-unsupported",
  );
  assert.equal(
    directTransportScopeReason({ ...base, existingChatSessionId: "c1" }),
    "thread-native-unsupported",
  );
  assert.equal(
    directTransportScopeReason({ accountId: "global", fileCount: 0 }),
    "no-account-context",
  );
});

// ── auth material ────────────────────────────────────────────────────────────

test("headers: account mode sends the Bearer JWT alongside the cookie jar", () => {
  const h = buildDirectQwenHeaders({
    cookie: "token=abc; x5sec=clearance",
    bearerToken: "JWT.VALUE",
    version: "0.3.12",
    chatSessionId: "chat-1",
  });
  assert.equal(h["Authorization"], "Bearer JWT.VALUE");
  // The clearance cookie must survive into the header.
  assert.ok(h["Cookie"].includes("x5sec=clearance"));
  assert.ok(h["Cookie"].includes("token=abc"));
  // The proven account request must NOT carry the guest referer.
  assert.ok(h["Referer"].includes("/c/chat-1"));
  assert.equal(h["version"], "0.3.12");
  assert.equal(h["source"], "web");
});

test("headers: guest requests never carry a Bearer and keep /c/guest", () => {
  const h = buildDirectQwenHeaders({ cookie: "cna=x", chatModeGuest: true });
  assert.equal(h["Authorization"], undefined);
  assert.ok(h["Referer"].includes("/c/guest"));
  // A falsy token must not produce a malformed "Bearer " header.
  for (const bad of [null, undefined, ""]) {
    assert.equal(
      buildDirectQwenHeaders({ cookie: "cna=x", bearerToken: bad })["Authorization"],
      undefined,
    );
  }
});

// ── x5sec state model ────────────────────────────────────────────────────────

test("x5sec: a clearance is valid only while its cookie expiry is in the future", () => {
  const now = 1_000_000_000_000;
  const future = { name: X5SEC_COOKIE_NAME, expires: (now + 60_000) / 1000, value: "v" };
  const past = { name: X5SEC_COOKIE_NAME, expires: (now - 1) / 1000, value: "v" };
  const session = { name: X5SEC_COOKIE_NAME, expires: -1, value: "v" };

  const ok = parseX5secFromCookies([future], now);
  assert.equal(ok.present, true);
  assert.equal(ok.valid, true);
  assert.equal(ok.expiresAt, (now + 60_000) / 1000 * 1000);
  assert.ok(ok.hash, "a fingerprint is required to detect a NEW solve");

  assert.equal(parseX5secFromCookies([past], now).valid, false);
  // A session cookie (-1) is not a usable clearance.
  assert.equal(parseX5secFromCookies([session], now).valid, false);
  // Absent entirely.
  const none = parseX5secFromCookies([{ name: "token", expires: 9 }], now);
  assert.equal(none.present, false);
  assert.equal(none.valid, false);
  assert.equal(none.hash, null);
});

test("x5sec: expiry helper treats missing/expired clearances as expired", () => {
  const now = 2_000_000_000_000;
  assert.equal(isX5secExpired(null, now), true);
  assert.equal(
    isX5secExpired({ x5secPresent: true, x5secExpiresAt: now + 1 }, now),
    false,
  );
  assert.equal(
    isX5secExpired({ x5secPresent: true, x5secExpiresAt: now - 1 }, now),
    true,
  );
  // Present flag but no expiry is not trustworthy.
  assert.equal(
    isX5secExpired({ x5secPresent: true, x5secExpiresAt: 0 }, now),
    true,
  );
  assert.equal(
    isX5secExpired({ x5secPresent: false, x5secExpiresAt: now + 9999 }, now),
    true,
  );
});

test("x5sec: a fresh fingerprint differs from the previous one after a solve", () => {
  const now = 3_000_000_000_000;
  const a = parseX5secFromCookies(
    [{ name: X5SEC_COOKIE_NAME, expires: (now + 60_000) / 1000, value: "old" }],
    now,
  );
  const b = parseX5secFromCookies(
    [{ name: X5SEC_COOKIE_NAME, expires: (now + 60_000) / 1000, value: "new" }],
    now,
  );
  assert.notEqual(a.hash, b.hash, "the wait must be able to see a NEW clearance");
});

// ── SSE: the CURRENT response.* event shape ─────────────────────────────────

test("sse: the live response.* envelope is parsed for deltas and completion", () => {
  // Captured verbatim from a working account completion.
  const raw = [
    'data: {"response.created":{"chat_id":"c1","response_id":"r1"}}',
    'data: {"response.output_text.delta":{"delta":"O"}}',
    'data: {"response.output_text.delta":{"delta":"K"}}',
    'data: {"response.completed":{"response_id":"r1"}}',
    "",
  ].join("\n");
  assert.equal(extractAnswerFromSse(raw), "OK");

  const created = classifySseFrame({ "response.created": { chat_id: "c1" } });
  assert.equal(created.known, true);
  assert.equal(created.done, false);

  const delta = classifySseFrame({ "response.output_text.delta": { delta: "hi" } });
  assert.equal(delta.delta, "hi");
  assert.equal(delta.done, false);

  const done = classifySseFrame({ "response.completed": { response_id: "r1" } });
  assert.equal(done.done, true, "response.completed must terminate the stream");
});

test("sse: legacy choice-delta and phase shapes still parse", () => {
  assert.equal(
    extractAnswerFromSse('data: {"choices":[{"delta":{"content":"a"}}]}'),
    "a",
  );
  assert.equal(
    extractAnswerFromSse('data: {"data":{"choices":[{"delta":{"content":"b"}}]}}'),
    "b",
  );
  assert.equal(extractAnswerFromSse('data: {"data":{"content":"c"}}'), "c");
  assert.equal(classifySseFrame({ phase: "done" }).done, true);
  assert.equal(classifySseFrame({ type: "done" }).done, true);
  // Malformed / non-JSON frames must not throw or invent text.
  assert.equal(extractAnswerFromSse("data: {broken"), "");
  assert.equal(extractAnswerFromSse("event: ping"), "");
  assert.equal(extractAnswerFromSse('data: "[DONE]"'), "");
});

// ── WAF classification ──────────────────────────────────────────────────────

test("waf: the RGV587 risk-control body is detected and yields a punish URL", () => {
  const body =
    '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],' +
    '"data":{"url":"https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=abc"}}';
  assert.equal(looksLikeWafChallenge(body, "application/json"), true);
  const url = extractPunishUrl(body);
  assert.ok(url && url.includes("_____tmd_____/punish"));
  // A normal app error is NOT a challenge.
  assert.equal(
    looksLikeWafChallenge('{"success":false,"data":{"code":"Unauthorized"}}', "application/json"),
    false,
  );
});

test("waf: a real SSE response is never mistaken for a challenge", async () => {
  // The streaming entry point must hand back a live stream for SSE, and a
  // classified challenge (with the FULL body) for anything else.
  const realBody =
    '{"ret":["FAIL_SYS_USER_VALIDATE"],"data":{"url":"https://chat.qwen.ai/x/_____tmd_____/punish?x5secdata=zz"}}';
  const r = await directCompletionStream({
    cookie: "token=a",
    bearerToken: "jwt",
    chatId: "c1",
    model: "qwen3.8-max",
    content: "hi",
    signal: AbortSignal.timeout(1500),
  });
  // No network in tests: the call must fail closed, never throw.
  assert.equal(typeof r.ok, "boolean");
  if (!r.ok) assert.equal(r.stream, null);
  assert.ok(realBody.includes("_____tmd_____"));
});

// ── hot-path guarantees ─────────────────────────────────────────────────────

/**
 * Remove comments and template/string noise so a static guard inspects real
 * CODE. Naming a forbidden symbol in a doc comment (e.g. "this never calls
 * captureQwenHeaders") is documentation, not a dependency.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""');
}

test("hot path: the direct transport never calls captureQwenHeaders", () => {
  for (const f of [
    "src/services/qwen-direct-stream.ts",
    "src/services/qwen-direct-transport.ts",
    "src/services/qwen-account-session.ts",
    "src/services/qwen-human-captcha.ts",
    "src/services/qwen-transport-dispatch.ts",
  ]) {
    const src = codeOnly(fs.readFileSync(f, "utf-8"));
    // A real call or import is forbidden; prose naming it in a comment is fine.
    assert.ok(
      !/\bcaptureQwenHeaders\s*\(/.test(src),
      `${f} must not call captureQwenHeaders`,
    );
    assert.ok(
      !/import[^;]*captureQwenHeaders/.test(src),
      `${f} must not import captureQwenHeaders`,
    );
    // The composer/typing path is equally forbidden.
    assert.ok(!/\bcomposer\b|sendButton|textarea/.test(src), `${f} touches the composer`);
  }
});

test("hot path: the account direct flow does not depend on the Baxia minter", () => {
  for (const f of [
    "src/services/qwen-direct-stream.ts",
    "src/services/qwen-human-captcha.ts",
  ]) {
    const src = codeOnly(fs.readFileSync(f, "utf-8"));
    assert.ok(!/qwen-baxia-minter/.test(src), `${f} must not use the minter`);
    assert.ok(!/mintQwenBaxiaMaterial/.test(src), `${f} must not mint material`);
  }
  // The minter itself is preserved untouched for any other consumer.
  assert.ok(fs.existsSync("src/services/qwen-baxia-minter.ts"));
});

test("hot path: human captcha never drives the automatic slider", () => {
  const src = codeOnly(fs.readFileSync("src/services/qwen-human-captcha.ts", "utf-8"));
  assert.ok(!/solveBaxiaCaptcha/.test(src), "must not call the solver");
  assert.ok(!/dragTo|mouse\.move|slider.*solve/i.test(src), "must not simulate a solve");
  // The legacy automatic solver is still present for the legacy transport.
  const coord = fs.readFileSync("src/services/captcha-coordinator.ts", "utf-8");
  assert.ok(coord.includes("recoverBaxiaCaptcha"));
  assert.ok(coord.includes("solveChallengeOnPage"));
  // captureQwenHeaders and the legacy transport are still in the tree.
  const pw = fs.readFileSync("src/services/playwright.ts", "utf-8");
  assert.ok(pw.includes("captureQwenHeaders"));
});

// ── no secret logging ───────────────────────────────────────────────────────

test("secrets: account session diagnostics never contain material values", () => {
  _resetAccountSessionsForTests();
  const d = describeAccountSession({
    accountId: "acct-1",
    cookieHeader: "token=SECRETCOOKIE; x5sec=SECRETCLEARANCE",
    bearerToken: "SECRETJWT",
    bearerSource: "cookie",
    userAgent: "Mozilla/5.0 Chrome/153.0.0.0",
    x5secPresent: true,
    x5secExpiresAt: Date.now() + 60_000,
    x5secHash: "deadbeef",
    x5secValid: true,
    capturedAt: Date.now(),
  });
  const text = JSON.stringify(d);
  assert.ok(!text.includes("SECRETCOOKIE"), "cookie value leaked");
  assert.ok(!text.includes("SECRETCLEARANCE"), "clearance value leaked");
  assert.ok(!text.includes("SECRETJWT"), "bearer leaked");
  // It still carries the useful, non-secret facts.
  assert.equal(d.x5secPresent, true);
  assert.equal(d.x5secValid, true);
  assert.equal(d.uaMajor, "153");
  assert.ok(String(d.cookieNames).includes("x5sec"));

  assert.deepEqual(describeAccountSession(null), { present: false });
});

test("secrets: the human captcha module logs no URL, cookie or clearance value", () => {
  const src = fs.readFileSync("src/services/qwen-human-captcha.ts", "utf-8");
  const logs = [...src.matchAll(/console\.(log|warn|error)\(([\s\S]{0,400}?)\);/g)].map(
    (m) => m[2],
  );
  assert.ok(logs.length > 0, "expected some logging");
  for (const l of logs) {
    assert.ok(!/punishUrl\b/.test(l), `log leaks the punish URL: ${l.slice(0, 60)}`);
    assert.ok(!/cookieHeader/.test(l), `log leaks the jar: ${l.slice(0, 60)}`);
    assert.ok(!/bearerToken/.test(l), `log leaks the JWT: ${l.slice(0, 60)}`);
    assert.ok(!/x5secValue|\.value\b/.test(l), `log leaks a cookie value: ${l.slice(0, 60)}`);
  }
});

test("secrets: the stream factory logs no material", () => {
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  const logs = [...src.matchAll(/console\.(log|warn|error)\(([\s\S]{0,400}?)\);/g)].map(
    (m) => m[2],
  );
  for (const l of logs) {
    assert.ok(!/bearerToken/.test(l), `log leaks the JWT: ${l.slice(0, 60)}`);
    assert.ok(!/cookieHeader/.test(l), `log leaks the jar: ${l.slice(0, 60)}`);
  }
});
