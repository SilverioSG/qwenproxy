/**
 * In-page refresh contract (validated live): GET auth.qwen.ai/api/v2/auths/refresh
 * from the browser context with credentials:include and the SPA interceptor
 * headers. Node/undici gets 405 HTML from the WAF.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildRefreshPageArgs } from "../services/qwen-token-refresh.ts";

test("in-page refresh uses the browser endpoint and official headers", () => {
  const args = buildRefreshPageArgs("0.3.27", "req-123");
  assert.equal(args.url, "https://auth.qwen.ai/api/v2/auths/refresh");
  assert.equal(args.headers.source, "web");
  assert.equal(args.headers.version, "0.3.27");
  assert.equal(args.headers["x-request-origin"], "https://chat.qwen.ai");
  assert.equal(args.headers["x-request-id"], "req-123");
  assert.ok((args.headers.timezone ?? "").length > 0);
  assert.match(args.headers.accept, /application\/json/);
});

test("no request body or credential material is part of the args", () => {
  const args = buildRefreshPageArgs("0.3.27", "req-456");
  const json = JSON.stringify(args).toLowerCase();
  assert.ok(!json.includes("cookie"));
  assert.ok(!json.includes("authorization"));
  assert.ok(!json.includes("password"));
  assert.ok(!json.includes("refresh_token="));
});
