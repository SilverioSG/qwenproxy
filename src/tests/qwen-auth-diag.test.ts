import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  extractBearerToken,
  bearerMatchesLiveToken,
  isUsableRefreshPayload,
  sanitizeRefreshErrorClass,
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
