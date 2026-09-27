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

test("qwen-auth-diag: in-page evaluate closure is __name-free (no bundler helpers)", () => {
  const src = fs.readFileSync("src/services/qwen.ts", "utf-8");
  const start = src.indexOf("const evaluateRequest = (page: Page)");
  assert.ok(start >= 0);
  // End of requestQwenTextInBrowser: the `return new Response(response.raw`
  // that follows the withQwenBrowserPage call.
  const end = src.indexOf("return new Response(response.raw", start);
  assert.ok(end > start);
  const block = src.slice(start, end);
  // Nested arrow-function declarations inside page.evaluate would be wrapped
  // with __name() by the bundler and throw ReferenceError in the page
  // (regression covered: d3c7140 family). Only direct parameter arrows and
  // method calls are allowed. Start inside the evaluate callback itself so
  // the outer Node-side wrapper is not counted.
  const innerStart = block.indexOf("page.evaluate(");
  assert.ok(innerStart >= 0);
  const inner = block.slice(innerStart);
  const nested = [...inner.matchAll(/const \w+ ?= ?(?:async )?\(.*?\) ?=>/gs)];
  assert.deepEqual(
    nested.map((m) => m[0].slice(0, 40)),
    [],
  );
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
