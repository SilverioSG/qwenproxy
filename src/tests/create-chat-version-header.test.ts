/**
 * POST /api/v2/chats/new must NOT carry the `version` header.
 *
 * A stale scraped frontend version makes that endpoint answer
 *   HTTP 200 {"code":"unauthorized","details":"401 Unauthorized"}
 * for an otherwise valid account session — same bearer, same cookie jar, same
 * User-Agent. With 0.2.91, 0.2.83, or with the header omitted, the same
 * request returns success:true. So the header is dropped for chat creation
 * instead of being pinned to a value that can rot the same way.
 *
 * /api/v2/chat/completions still REQUIRES `version`; this must not leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildDirectQwenHeaders } from "../services/qwen-direct-transport.ts";

// ── A / B the header is gone from create-chat, whatever the scrape returns ──

test("create-chat: the version header is omitted", async () => {
  const { directCreateChat } = await import("../services/qwen-direct-transport.ts");
  // Intercept the outbound request to assert on the real headers.
  const realFetch = globalThis.fetch;
  let seen: Record<string, string> | null = null;
  let seenUrl = "";
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/api/v2/chats/new")) {
      seenUrl = url;
      seen = { ...(init?.headers ?? {}) };
      return new Response('{"success":false,"data":{"code":"StopTest"}}', {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await directCreateChat({
      cookie: "token=abc; x5sec=clear", model: "qwen3.8-max",
      chatMode: "normal", chatType: "t2t", bearerToken: "JWT",
      version: "0.3.12", // the stale value that produced the 401
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen, "the create-chat request must have been intercepted");
  assert.ok(seenUrl.includes("/api/v2/chats/new"));
  assert.equal(
    Object.keys(seen!).some((k) => k.toLowerCase() === "version"),
    false,
    "create-chat must not send a version header",
  );
  assert.equal((seen as any).version, undefined);
});

test("create-chat: the builder drops version only when asked", () => {
  // Omitted for create-chat…
  const noVersion = buildDirectQwenHeaders({ cookie: "cna=x", omitVersion: true, version: "0.3.12" });
  assert.equal("version" in noVersion, false);
  // …and preserved for everything else, including completions.
  const withVersion = buildDirectQwenHeaders({ cookie: "cna=x", version: "0.3.12" });
  assert.equal(withVersion.version, "0.3.12");
  // The default path still falls back to the shared store when unset.
  const fallback = buildDirectQwenHeaders({ cookie: "cna=x" });
  assert.ok("version" in fallback, "completions must keep version by default");
});

// ── F the completion contract is untouched ─────────────────────────────────

test("completion: still sends version, and still uses the response.* parser", async () => {
  const { directCompletionStream } = await import("../services/qwen-direct-transport.ts");
  const realFetch = globalThis.fetch;
  let seen: Record<string, string> | null = null;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/api/v2/chat/completions")) {
      seen = { ...(init?.headers ?? {}) };
      const body =
        'data: {"response.output_text.delta":{"delta":"OK"}}\n\n' +
        'data: {"response.completed":{}}\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  let res: any;
  try {
    res = await directCompletionStream({
      cookie: "token=abc", bearerToken: "JWT", chatId: "c1", model: "qwen3.8-max",
      content: "Responde únicamente: OK", version: "0.3.12",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen, "the completion request must have been intercepted");
  assert.equal((seen as any).version, "0.3.12", "completions keep the version header");
  assert.equal(res.ok, true);
  assert.ok(res.stream, "a real SSE stream must be returned");
});

// ── C / D / E the surrounding behaviour is unchanged ───────────────────────

test("unchanged: DB-first bearer precedence is untouched by this fix", () => {
  const src = fs.readFileSync("src/services/qwen-account-session.ts", "utf-8");
  const at = src.indexOf("const bearerToken =");
  const line = src.slice(at, src.indexOf("\n", at));
  assert.ok(
    /dbToken\s*\|\|\s*lsToken\s*\|\|\s*cookieToken/.test(line),
    "precedence must stay db > localStorage > cookie",
  );
  assert.ok(src.includes('bearerSource: "db" | "localStorage" | "cookie" | "none"'));
});

test("unchanged: the live cookie jar and x5sec still come from the browser", () => {
  const src = fs.readFileSync("src/services/qwen-account-session.ts", "utf-8");
  assert.ok(/applicable\.find\(\(c\) => c\.name === ACCOUNT_TOKEN_COOKIE_NAME\)/.test(src),
    "the live jar is still read from the context");
  assert.ok(/const x5 = parseX5secFromCookies\(applicable\)/.test(src),
    "x5sec still comes from the live context");
});

test("unchanged: the feature flag still defaults to false", () => {
  const cfg = fs.readFileSync("src/core/config.ts", "utf-8");
  assert.ok(/QWEN_DIRECT_WEB_TRANSPORT: z\.string\(\)\.default\("false"\)/.test(cfg));
  assert.ok(/directWebTransport: env\.QWEN_DIRECT_WEB_TRANSPORT === "true"/.test(cfg));
});

test("unchanged: WAF recovery, retry policy and the minter are untouched", () => {
  const dt = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  // Recovery still runs at most once, on a brand new chat.
  const orch = dt.slice(dt.indexOf("export async function directChatWithWafRecovery"));
  assert.equal((orch.match(/recoverWithHumanCaptcha\(/g) ?? []).length, 1);
  assert.ok(orch.includes("const second = await runLeg("));
  // Retry policy keeps its single distinct classification.
  const rp = fs.readFileSync("src/routes/chat/retry-policy.ts", "utf-8");
  assert.ok(rp.includes("isDirectClearanceExhausted"));
  // The minter is not on the account path.
  assert.ok(!/qwen-baxia-minter/.test(fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8")));
  // The legacy capture path is still present for flag=false.
  assert.ok(fs.readFileSync("src/services/playwright.ts", "utf-8").includes("captureQwenHeaders"));
});

test("scope: no other call site was changed to omit the version", () => {
  const dt = fs.readFileSync("src/services/qwen-direct-transport.ts", "utf-8");
  // omitVersion appears exactly once: the create-chat call site.
  assert.equal((dt.match(/omitVersion: true/g) ?? []).length, 1);
  const at = dt.indexOf("omitVersion: true");
  const before = dt.slice(Math.max(0, at - 1200), at);
  assert.ok(before.includes("/api/v2/chats/new") || before.includes("accountMode"),
    "the opt-out must sit on the create-chat call site");
  // getFrontendVersion is NOT neutered for other consumers.
  assert.ok(dt.includes("export async function getFrontendVersion"));
  assert.ok(/version: input\.version \|\| getQwenWebVersion\(\)/.test(dt),
    "the default path still resolves a version");
});
