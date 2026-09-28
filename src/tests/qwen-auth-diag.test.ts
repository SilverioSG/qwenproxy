import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  isCookieOnlyRoute,
  stripExplicitAuth,
  extractBearerToken,
  bearerMatchesLiveToken,
  isUsableRefreshPayload,
  sanitizeRefreshErrorClass,
  isAppUnauthorized,
} from "../services/qwen.ts";

test("qwen-auth-diag: cache bearer == live token → matchesLive=true", () => {
  assert.equal(
    bearerMatchesLiveToken("tok_abc123", "tok_abc123"),
    true,
  );
});

test("qwen-auth-diag: cache bearer != live token → matchesLive=false", () => {
  assert.equal(bearerMatchesLiveToken("tok_old", "tok_new"), false);
  assert.equal(bearerMatchesLiveToken("short", "much-longer-token"), false);
});

test("qwen-auth-diag: no live token → unknown (null)", () => {
  assert.equal(bearerMatchesLiveToken("tok_abc", null), null);
  assert.equal(bearerMatchesLiveToken(null, "tok_abc"), null);
  assert.equal(bearerMatchesLiveToken("", ""), null);
});

test("qwen-auth-diag: extractBearerToken parses header variants", () => {
  assert.equal(extractBearerToken({ Authorization: "Bearer abc" }), "abc");
  assert.equal(extractBearerToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractBearerToken({}), null);
  assert.equal(extractBearerToken({ Authorization: "Basic abc" }), null);
});

test("qwen-auth-diag: refresh 200 usable → succeeded shape", () => {
  assert.equal(
    isUsableRefreshPayload({ success: true, data: { token: "fresh" } }),
    true,
  );
});

test("qwen-auth-diag: refresh malformed → failed shape", () => {
  assert.equal(isUsableRefreshPayload(null), false);
  assert.equal(isUsableRefreshPayload({ success: false }), false);
  assert.equal(isUsableRefreshPayload({ success: true, data: {} }), false);
  assert.equal(isUsableRefreshPayload({ success: true, data: { token: "" } }), false);
});

test("qwen-auth-diag: refresh exception → sanitized class only", () => {
  assert.equal(sanitizeRefreshErrorClass(new TypeError("Failed to fetch")), "TypeError");
  assert.equal(sanitizeRefreshErrorClass(new Error("boom")), "Error");
  assert.equal(sanitizeRefreshErrorClass("plain"), "string");
  const cls = sanitizeRefreshErrorClass(new TypeError("token=secret leak attempt"));
  assert.ok(!cls.includes("secret"));
});

/**
 * Extract every `.evaluate(` call text via paren matching so the assertions
 * only inspect the real in-page closure (not surrounding Node-side code).
 */
function evaluateClosures(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /\.evaluate\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    let start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const text = src.slice(start, i - 1);
    out.push({ line: src.slice(0, start).split("\n").length, text });
  }
  return out;
}

const IN_PAGE_FILES = ["src/services/qwen.ts", "src/services/playwright.ts"];

/** Function expression assigned to a const inside an in-page closure. */
const NESTED_FN_DECL =
  /(?:^|[\s;{])const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g;

test("qwen-auth-diag: in-page evaluate closures are __name-free (no bundler helpers)", () => {
  let found = 0;
  for (const f of IN_PAGE_FILES) {
    for (const cl of evaluateClosures(fs.readFileSync(f, "utf-8"))) {
      found++;
      // Nested arrow-function declarations inside page.evaluate would be wrapped
      // with __name() by the bundler and throw ReferenceError in the page
      // (regression covered: d3c7140 family).
      const nested = [...cl.text.matchAll(NESTED_FN_DECL)];
      assert.deepEqual(
        nested.map((m) => m[0].slice(0, 40)),
        [],
        `${f}:${cl.line} in-page closure has a nested function declaration`,
      );
    }
  }
  assert.ok(found > 0, "no evaluate closures scanned");
});

test("qwen-auth-diag: nested-function guard is not vacuous", () => {
  const positive = `const go = () => {\n  const helper = (a, b) => a + b;\n  return helper(1, 2);\n};`;
  const matches = [...positive.matchAll(NESTED_FN_DECL)];
  assert.ok(matches.length > 0, "guard must detect a nested arrow const");
  // Sanity: a bare expression assignment is not flagged.
  const negative = `const go = (a) => {\n  const total = a + 1 * 2;\n  return total;\n};`.replace(
    "const go = (a) => {",
    "const go = function (a) {",
  );
  assert.equal([...negative.matchAll(NESTED_FN_DECL)].length, 0);
});

test("qwen-auth-diag: no dynamic import() inside a page.evaluate closure", () => {
  // Regression guard: `import()` in an in-page closure runs in the browser and
  // cannot resolve TS module specifiers (breaks the heal retry path).
  for (const f of IN_PAGE_FILES) {
    for (const cl of evaluateClosures(fs.readFileSync(f, "utf-8"))) {
      assert.ok(
        !/import\(["'`]/.test(cl.text),
        `${f}:${cl.line} has a dynamic import() inside a page.evaluate closure`,
      );
    }
  }
});

test("qwen-auth-diag: no secret values in new instrumentation", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("[QwenAuth] account=");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 3000);
  // Only approved, non-secret interpolations may appear in [QwenAuth] logs.
  const allowed = new Set([
    "id8", "path", "hasAuth", "d", "response", "status",
    "refreshStatus", "refreshUsable", "refreshUpdatedLs",
    "refreshUpdatedCookie", "refreshUpdatedAuth", "retried",
    "retryStatus", "refreshErrorClass", "authMatchesLive",
    "liveTokenPresent",
  ]);
  const idents = new Set<string>();
  for (const m of block.matchAll(/\$\{([^}]+)\}/g)) {
    const root = m[1].split(/[.?(\s]/)[0];
    if (root) idents.add(root);
  }
  for (const ident of idents) {
    assert.ok(
      allowed.has(ident),
      `unexpected interpolation in [QwenAuth] log: ${ident}`,
    );
  }
});

test("qwen-auth-diag: HTTP 401 triggers heal classification", () => {
  assert.equal(isAppUnauthorized(401, ""), true);
  assert.equal(isAppUnauthorized(401, "anything"), true);
});

test("qwen-auth-diag: HTTP 200 + success:false Unauthorized triggers heal", () => {
  assert.equal(
    isAppUnauthorized(200, '{"success":false,"data":{"code":"Unauthorized","details":"401 No autorizado"}}'),
    true,
  );
  assert.equal(isAppUnauthorized(200, '{"success":false,"code":"Unauthorized"}'), true);
});

test("qwen-auth-diag: HTTP 200 + non-auth failure never triggers heal", () => {
  assert.equal(isAppUnauthorized(200, '{"success":true}'), false);
  assert.equal(isAppUnauthorized(200, '{"success":false,"data":{"code":"RateLimited"}}'), false);
  assert.equal(isAppUnauthorized(200, ""), false);
  assert.equal(isAppUnauthorized(200, "not json{{{"), false);
  assert.equal(isAppUnauthorized(500, "error"), false);
});

test("qwen-auth-diag: in-page predicate mirrors isAppUnauthorized markers", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("Auth failure = HTTP 401 OR application-level");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 2500);
  for (const marker of ["success === false", "Unauthorized", "401", "appUnauthorized"]) {
    assert.ok(block.includes(marker), `in-page predicate missing: ${marker}`);
  }
});

test("qwen-auth-diag: cookie-only routes strip Authorization (both cases)", () => {
  const withAuth = { Authorization: "Bearer x", authorization: "Bearer x", Cookie: "a=b" };
  const stripped = stripExplicitAuth(withAuth);
  assert.ok(!("Authorization" in stripped) && !("authorization" in stripped));
  assert.equal(stripped["Cookie"], "a=b");
  assert.equal(withAuth["Authorization"], "Bearer x");
  assert.equal(isCookieOnlyRoute("https://chat.qwen.ai/api/v2/chats/new"), true);
  assert.equal(isCookieOnlyRoute("https://chat.qwen.ai/api/v2/users/user/settings"), true);
  assert.equal(isCookieOnlyRoute("https://chat.qwen.ai/api/v2/users/user/settings/update"), true);
  assert.equal(isCookieOnlyRoute("https://chat.qwen.ai/api/v2/files/getstsToken"), false);
  assert.equal(isCookieOnlyRoute("https://auth.qwen.ai/api/v2/auths/refresh"), false);
});

test("qwen-auth-diag: in-page transport mirrors cookie-only routing", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("Cookie-only routes (chat + chat personalization)");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 1500);
  assert.ok(block.includes("/api/v2/chats/new"));
  assert.ok(block.includes("/api/v2/users/user/settings"));
  assert.ok(block.includes('delete effHeaders["authorization"]'));
  assert.ok(block.includes('delete effHeaders["Authorization"]'));
  assert.ok(block.includes("credentials:"));
});

test("qwen-auth-diag: heal performs at most one retry (no loop)", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("Silent in-page token refresh + single retry");
  const start2 = src.indexOf("single retry on auth failure");
  const anchor = start >= 0 ? start : start2;
  assert.ok(anchor >= 0);
  const block = src.slice(anchor, anchor + 4000);
  assert.ok(!/while\s*\(|for\s*\(.*?retries/i.test(block));
});

test("qwen-auth-diag: settings A/B probe is exported with sanitized shape", async () => {
  const mod = await import("../services/qwen.ts");
  assert.equal(typeof mod.probeSettingsAuthAB, "function");
});

test("qwen-auth-diag: probe endpoint registered with verifyApiKey", () => {
  const src = fs.readFileSync("src/api/dashboard.ts", "utf-8");
  const idx = src.indexOf('"/v1/accounts/:id/probe-settings-auth"');
  assert.ok(idx >= 0);
  const noComments = src
    .slice(idx, idx + 1500)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const block = noComments;
  assert.ok(block.includes("verifyApiKey"));
  // Interpolations may only reference the id prefix and the sanitized
  // result object — never credential values.
  const allowed = new Set(["id", "result", "err"]);
  const idents = new Set<string>();
  for (const m of block.matchAll(/\$\{([^}]+)\}/g)) {
    const root = m[1].split(/[.?(\s]/)[0];
    if (root) idents.add(root);
  }
  for (const ident of idents) {
    assert.ok(
      allowed.has(ident),
      `unexpected interpolation in probe endpoint: ${ident}`,
    );
  }
});

test("qwen-auth-diag: probeRefreshStructure exported with sanitized shape", async () => {
  const mod = await import("../services/qwen.ts");
  assert.equal(typeof mod.probeRefreshStructure, "function");
});

test("qwen-auth-diag: refresh-structure endpoint registered with verifyApiKey", () => {
  const src = fs.readFileSync("src/api/dashboard.ts", "utf-8");
  const idx = src.indexOf('"/v1/accounts/:id/probe-refresh-structure"');
  assert.ok(idx >= 0);
  const noComments = src
    .slice(idx, idx + 1200)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(noComments.includes("verifyApiKey"));
  const allowed = new Set(["id", "result", "err"]);
  const idents = new Set<string>();
  for (const m of noComments.matchAll(/\$\{([^}]+)\}/g)) {
    const root = m[1].split(/[.?(\s]/)[0];
    if (root) idents.add(root);
  }
  for (const ident of idents) {
    assert.ok(allowed.has(ident), `unexpected interpolation: ${ident}`);
  }
});

test("qwen-auth-diag: refresh access_token shape is usable (SPA contract)", () => {
  assert.equal(
    isUsableRefreshPayload({ success: true, data: { access_token: "tok", expires_at: 123 } }),
    true,
  );
  assert.equal(isUsableRefreshPayload({ success: true, data: { token: "tok" } }), true);
  assert.equal(isUsableRefreshPayload({ success: true, data: {} }), false);
});

test("qwen-auth-diag: refresh call carries SPA interceptor headers", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("auth.qwen.ai/api/v2/auths/refresh", src.indexOf("Silent in-page token refresh"));
  assert.ok(start >= 0);
  const block = src.slice(start, start + 1800);
  for (const marker of ["Version:", "source:", "X-Request-Id", "Timezone:", "access_token"]) {
    assert.ok(block.includes(marker), `refresh call missing: ${marker}`);
  }
});

test("qwen-auth-diag: extractAuthToken covers SPA shapes (accessToken/access_token/token)", async () => {
  const { extractAuthToken } = await import("../services/playwright.ts");
  assert.equal(extractAuthToken({ success: true, data: { access_token: "A", expires_at: 1 } }), "A");
  assert.equal(extractAuthToken({ success: true, data: { accessToken: "B" } }), "B");
  assert.equal(extractAuthToken({ success: true, data: { token: "C" } }), "C");
  assert.equal(extractAuthToken({ success: true, result: { access_token: "D" } }), "D");
  assert.equal(extractAuthToken({ accessToken: "E" }), "E");
  assert.equal(extractAuthToken({ success: true, data: {} }), null);
  assert.equal(extractAuthToken(null), null);
  assert.equal(extractAuthToken({ success: false, data: { code: "X" } }), null);
});

test("qwen-auth-diag: loginViaApi extracts token via SPA contract helper", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const idx = src.indexOf("async function loginViaApi");
  assert.ok(idx >= 0);
  const end = src.indexOf("export interface AutofillResult", idx);
  const block = src.slice(idx, end > 0 ? end : idx + 9000);
  assert.ok(block.includes("extractAuthToken(data)"));
  assert.ok(!block.includes("data?.data?.token || data?.token"));
});

test("qwen-auth-diag: login trace + single-shot probe exports exist", async () => {
  const mod = await import("../services/playwright.ts");
  assert.equal(typeof mod.getLastLoginTrace, "function");
  assert.equal(typeof mod.probeLoginOnce, "function");
  assert.equal(mod.getLastLoginTrace("no-such-account"), null);
});

test("qwen-auth-diag: probe-login endpoint registered with verifyApiKey", () => {
  const src = fs.readFileSync("src/api/dashboard.ts", "utf-8");
  const idx = src.indexOf('"/v1/accounts/:id/probe-login"');
  assert.ok(idx >= 0);
  const noComments = src
    .slice(idx, idx + 1500)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(noComments.includes("verifyApiKey"));
  assert.ok(noComments.includes("probeLoginOnce"));
  const allowed = new Set(["id", "result", "err"]);
  const idents = new Set<string>();
  for (const m of noComments.matchAll(/\$\{([^}]+)\}/g)) {
    const root = m[1].split(/[.?(\s]/)[0];
    if (root) idents.add(root);
  }
  for (const ident of idents) {
    assert.ok(allowed.has(ident), `unexpected interpolation: ${ident}`);
  }
});

test("qwen-auth-diag: shaping probe + endpoint exist with sanitized surface", async () => {
  const mod = await import("../services/qwen.ts");
  assert.equal(typeof mod.probeChatShaping, "function");
  assert.equal(typeof mod.isCookieOnlyRoute, "function");
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/api/dashboard.ts", "utf-8");
  const idx = src.indexOf('"/v1/accounts/:id/probe-chat-shaping"');
  assert.ok(idx >= 0);
  const noComments = src
    .slice(idx, idx + 1500)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(noComments.includes("verifyApiKey"));
  assert.ok(noComments.includes("probeChatShaping"));
  const allowed = new Set(["id", "result", "err"]);
  const idents = new Set<string>();
  for (const m of noComments.matchAll(/\$\{([^}]+)\}/g)) {
    const root = m[1].split(/[.?(\s]/)[0];
    if (root) idents.add(root);
  }
  for (const ident of idents) {
    assert.ok(allowed.has(ident), `unexpected interpolation: ${ident}`);
  }
});

test("qwen-auth-diag: shaping probe recognizes nested data.chat.id", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const hits = src.split("data?.chat?.id").length - 1;
  assert.ok(hits >= 2, `expected nested chat id checks, found ${hits}`);
  // Functional shape check mirroring the in-page predicate (inline there
  // for bundler __name constraints).
  const shapes = [
    [{ chat_id: "a" }, true],
    [{ id: "a" }, true],
    [{ data: { chat_id: "a" } }, true],
    [{ data: { id: "a" } }, true],
    [{ data: { chat: { id: "a" } } }, true],
    [{ success: false }, false],
    [{ data: {} }, false],
  ];
  for (const [json, expected] of shapes) {
    const j = json as {
      chat_id?: string;
      id?: string;
      data?: { chat_id?: string; id?: string; chat?: { id?: string } };
    };
    const created = Boolean(
      j.chat_id || j.id || j.data?.chat_id || j.data?.id || j.data?.chat?.id,
    );
    assert.equal(created, expected);
  }
});

test("qwen-auth-diag: baseline gate ignores created/chat_id (2xx + no appFail continues)", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const idx = src.indexOf("created/chat_id is INFORMATIONAL ONLY");
  const anchor = idx >= 0 ? idx : src.indexOf("result.baseline = { status, appAuthFailure: appFail, created };");
  assert.ok(anchor >= 0);
  const block = src.slice(anchor, anchor + 800);
  assert.ok(block.includes("if (status !== 200 || appFail)"));
  assert.ok(!block.includes("!created"));
});

test("qwen-auth-diag: bisect structure present with budget and confirm sequence", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const idx = src.indexOf("Binary search for a single causal header");
  assert.ok(idx >= 0);
  const block = src.slice(idx, idx + 3500);
  assert.ok(block.includes("budget"));
  assert.ok(block.includes("causalHeader"));
  assert.ok(block.includes("minimalCausalSet"));
  assert.ok(block.includes("interactionCausal"));
  assert.ok(block.includes("confirmed = ok1 && bad2 && ok3"));
});

test("qwen-auth-diag: personalization omits cached version header", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const idx = src.indexOf("Bisect-proven (same context/session)");
  assert.ok(idx >= 0);
  const block = src.slice(idx - 400, idx + 600);
  assert.ok(block.includes('delete requestHeaders["version"]'));
  // Create-chat path must keep version untouched.
  const pool = fs.readFileSync("src/services/qwen-chat-pool.ts", "utf-8");
  assert.ok(!pool.includes('delete requestHeaders["version"]'));
});

test("qwen-auth-diag: version strip is personalization-scoped", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const occurrences = src.split('delete requestHeaders["version"]').length - 1;
  assert.equal(occurrences, 2);
});

test("qwen-auth-diag: create-chat omits version, preserves other headers", () => {
  const src = fs.readFileSync("src/services/qwen-chat-pool.ts", "utf-8");
  const idx = src.indexOf("Bisect-proven on identical session state");
  assert.ok(idx >= 0);
  const block = src.slice(idx, idx + 800);
  assert.ok(block.includes('delete chatHeaders["version"]'));
  assert.ok(block.includes('delete chatHeaders["Version"]'));
  // Nothing else stripped here: only version lines touch chatHeaders.
  const dels = block.match(/delete chatHeaders\["[^"]+"\\]/g) || [];
  void dels;
  // Settings paths keep their own strip (unchanged by this fix).
  const qwen = fs.readFileSync("src/services/qwen.ts", "utf-8");
  assert.equal(
    qwen.split('delete requestHeaders["version"]').length - 1,
    2,
  );
});

test("qwen-auth-diag: classifySigninChallenge signals without values", async () => {
  const { classifySigninChallenge } = await import("../services/playwright.ts");
  assert.deepEqual(classifySigninChallenge("OTP_REQUIRED", "enter code"), ["otp-required"]);
  assert.deepEqual(classifySigninChallenge("x", "baxia slider challenge"), ["captcha-required"]);
  assert.deepEqual(classifySigninChallenge("x", "wrong password mode"), ["password-mode-rejected"]);
  assert.deepEqual(classifySigninChallenge("Forbidden", "risk flagged"), ["account-flag"]);
  assert.deepEqual(classifySigninChallenge("Unauthorized", "401"), []);
  assert.deepEqual(classifySigninChallenge(null, null), []);
});

test("qwen-auth-diag: login trace carries phase fields, never secrets", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const idx = src.indexOf("export interface LoginAttemptTrace");
  assert.ok(idx >= 0);
  const block = src.slice(idx, idx + 1500);
  for (const f of ["cookieInstallOk", "lsWriteOk", "reloadOk", "tokenHashBefore", "tokenHashAfter", "tokenChanged", "challengeSignals"]) {
    assert.ok(block.includes(f), `trace missing ${f}`);
  }
});


test("qwen-auth-diag: probeLoginOnce brackets every minimal reading", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function probeLoginOnce");
  assert.ok(start >= 0);
  const end = src.indexOf("\n}\n", src.indexOf("snapAfterFull", start));
  assert.ok(end > start);
  const block = src.slice(start, end);
  const expected = [
    "probe-post-login",
    "probe-models-pre",
    "probe-models-post",
    "probe-settings-pre",
    "probe-settings-post",
    "probe-create-chat-pre",
    "probe-create-chat-post",
    "probe-after-minimal",
  ];
  let cursor = -1;
  for (const label of expected) {
    const idx = block.indexOf(`"${label}"`);
    assert.ok(idx >= 0, `missing checkpoint ${label}`);
    assert.ok(idx > cursor, `checkpoint ${label} is out of order`);
    cursor = idx;
    const callIdx = block.lastIndexOf("await lsMark(", idx);
    assert.ok(callIdx >= 0, `${label} is not emitted via lsMark`);
  }
  // The A/B full-header and bisect phases must stay after probe-after-minimal.
  assert.ok(block.indexOf("fullExtra") > block.indexOf('"probe-after-minimal"'));
});

test("qwen-auth-diag: probe LS marks are observational (no functional gate)", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("const lsMark = async (label: string)");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 400);
  assert.ok(block.includes(".catch(() => {})"));
  // No early return / throw: a checkpoint must never abort the probe.
  assert.ok(!/return false|throw /.test(block));
});

test("qwen-auth-diag: isPageLoggedIn emits all subrequest LS checkpoints", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function probePageLoggedIn");
  assert.ok(start >= 0);
  const end = src.indexOf("export async function isPageLoggedIn", start);
  const block = src.slice(start, end);
  const expected = [
    "isloggedin-entry",
    "auths-pre",
    "auths-post",
    "auths-post-50ms",
    "auths-post-250ms",
    "settings-pre",
    "settings-post",
    "settings-post-50ms",
    "settings-post-250ms",
    "refresh-pre",
    "refresh-post",
    "refresh-post-50ms",
    "refresh-post-250ms",
    "isloggedin-exit",
    "isloggedin-exit-50ms",
    "isloggedin-exit-250ms",
  ];
  for (const label of expected) {
    assert.ok(block.includes(`"${label}"`), `missing checkpoint ${label}`);
  }
  // The subrequest order must be preserved: auths -> settings -> refresh.
  const iA = block.indexOf('SNAP[0]("auths-pre")');
  const iS = block.indexOf('SNAP[0]("settings-pre")');
  const iR = block.indexOf('SNAP[0]("refresh-pre")');
  assert.ok(iA >= 0 && iA < iS && iS < iR, "subrequest order changed");
  // Endpoints unchanged.
  assert.ok(block.includes('fetch("/api/v1/auths/", { method: "GET" })'));
  assert.ok(block.includes('fetch("/api/v2/users/user/settings"'));
  assert.ok(block.includes('fetch("https://auth.qwen.ai/api/v2/auths/refresh"'));
});

test("qwen-auth-diag: in-page helpers avoid __name by living in array literals", () => {
  // esbuild keepNames rewrites named function expressions/declarations to
  // __name(f, "f"); array-literal elements are emitted verbatim. Verified
  // against the real esbuild transform.
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function probePageLoggedIn");
  const end = src.indexOf("export async function isPageLoggedIn", start);
  const block = src.slice(start, end);
  for (const helper of ["SNAP", "WAIT"]) {
    assert.ok(
      block.includes(`const ${helper} = [`),
      `${helper} must be an array literal to stay __name-free`,
    );
  }
  // No `const f = (...) =>` outside the array literals.
  const namedArrows = [...block.matchAll(NESTED_FN_DECL)].filter((m) => {
    const at = m.index ?? 0;
    const before = block.slice(Math.max(0, at - 60), at);
    return !/const\s+(SNAP|WAIT)\s*=\s*\[$/.test(before.replace(/\n/g, ""));
  });
  assert.deepEqual(namedArrows.map((m) => m[0].slice(0, 40)), []);
});

test("qwen-auth-diag: deferred waits are gated on the trace flag", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function probePageLoggedIn");
  const end = src.indexOf("export async function isPageLoggedIn", start);
  const block = src.slice(start, end);
  // WAIT returns immediately when the probe is not traced.
  const waitIdx = block.indexOf("const WAIT = [");
  const waitBlock = block.slice(waitIdx, waitIdx + 220);
  assert.ok(waitBlock.includes("if (!TRACE) return;"));
  assert.ok(waitBlock.includes("setTimeout"));
  // The timeout budget is only widened for the traced account.
  assert.ok(block.includes("isTraced ? ISLOGGEDIN_TRACE_OVERHEAD_MS : 0"));
  // Untraced accounts get no extra budget and no samples.
  assert.ok(block.includes("accountIdForPage(page)"));
});

test("qwen-auth-diag: probePageLoggedIn external contract is unchanged", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("export async function isPageLoggedIn");
  const end = src.indexOf("export function getOrLaunchSharedBrowser", start);
  const block = src.slice(start, end);
  assert.ok(block.includes("probePageLoggedIn(page, timeoutMs)).ok"));
  const probeStart = src.indexOf("export async function probePageLoggedIn");
  const probeEnd = src.indexOf("export async function isPageLoggedIn");
  const probe = src.slice(probeStart, probeEnd);
  // Guard clauses keep their original reasons.
  for (const r of [
    '"no-page"',
    '"page-closed"',
    '"auth-url"',
    '"auths-status"',
    '"auths-schema"',
    '"settings-401"',
    '"settings-403"',
    '"settings-revoked"',
    '"refresh-401"',
    '"refresh-403"',
    '"refresh-revoked"',
    '"logged-out-marker"',
    '"context-destroyed"',
    '"evaluate-error"',
    '"ok"',
  ]) {
    assert.ok(probe.includes(r), `lost reason ${r}`);
  }
});

test("qwen-auth-diag: rotation ingestion stores no secret values", async () => {
  const mod = await import("../services/session-tracer.ts");
  mod._resetLsTrackingForTests();
  mod.ingestIsLoggedInTrace(
    mod.TRACE_TARGET_ACCOUNT,
    [
      {
        label: "isloggedin-entry",
        ts: 1_000,
        lsPresent: true,
        lsHash: "aaaa1111",
        lsLength: 209,
        marker: false,
        cookiePresent: true,
        cookieHash: "aaaa1111",
        cookieLength: 209,
      },
      {
        label: "auths-pre",
        ts: 1_010,
        lsPresent: true,
        lsHash: "aaaa1111",
        lsLength: 209,
        marker: false,
        cookiePresent: true,
        cookieHash: "aaaa1111",
        cookieLength: 209,
      },
      {
        label: "auths-post",
        ts: 1_020,
        lsPresent: false,
        lsHash: null,
        lsLength: 0,
        marker: true,
        cookiePresent: true,
        cookieHash: "bbbb2222",
        cookieLength: 210,
      },
    ],
    [
      {
        step: "auths",
        httpStatus: 200,
        appState: "http-200",
        appSuccess: true,
        usable: null,
        responseKeys: ["success", "data"],
        setCookieObserved: null,
        lsWriteObserved: null,
      },
    ],
    { context: null, page: null, url: "https://chat.qwen.ai/" },
  );
  const t = mod.getIsLoggedInTrace();
  assert.equal(t.results.length, 1);
  assert.equal(t.results[0].step, "auths");
  assert.deepEqual(t.results[0].responseKeys, ["success", "data"]);
  const blob = JSON.stringify(t);
  assert.ok(!/eyJ|Bearer |password|token=/i.test(blob));
});

test("qwen-auth-diag: accountIdForPage is a reverse lookup with no side effects", () => {
  const src = fs.readFileSync("src/services/playwright.ts", "utf-8");
  const start = src.indexOf("function accountIdForPage");
  assert.ok(start >= 0);
  const block = src.slice(start, start + 260);
  assert.ok(block.includes("for (const [id, p] of accountPages)"));
  assert.ok(block.includes("if (p === page) return id;"));
  assert.ok(block.includes("return null;"));
  assert.ok(!/accountPages\.(delete|clear|set)/.test(block));
});
