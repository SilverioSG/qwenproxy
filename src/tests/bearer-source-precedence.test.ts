/**
 * Bearer source precedence for the direct account transport.
 *
 *   1. localStorage.token   (the SPA's own token)
 *   2. cookie "token"        (the account session cookie — what pool accounts have)
 *   3. neither              -> the existing unsupported/fallback behaviour
 *
 * Verified live: the cookie value IS a JWT the upstream accepts as a Bearer
 * (/chats/new returns success:true with it). localStorage.token is a
 * DIFFERENT, longer token and is not required.
 *
 * The cookie is only READ; the jar must keep carrying it on the Cookie header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ACCOUNT_TOKEN_COOKIE_NAME,
  X5SEC_COOKIE_NAME,
  captureAccountSessionFromPage,
  describeAccountSession,
  _resetAccountSessionsForTests,
} from "../services/qwen-account-session.ts";
import { buildDirectQwenHeaders } from "../services/qwen-direct-transport.ts";

/**
 * Minimal page double: the only surface captureAccountSessionFromPage uses is
 * context().cookies() and evaluate() for the localStorage/UA read.
 */
function fakePage(opts: {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number }>;
  lsToken: string;
}) {
  return {
    context: () => ({ cookies: async () => opts.cookies }),
    evaluate: async () => ({ token: opts.lsToken, userAgent: "Mozilla/5.0 Chrome/153.0.0.0" }),
  } as unknown as Parameters<typeof captureAccountSessionFromPage>[1];
}

const COOKIE_TOKEN = "eyJWT.cookie.value.signature";
const LS_TOKEN = "eyJ-bigger-localstorage-token.value.signature-xx";
const jar = (withCookie: boolean) => [
  { name: "cna", value: "x", domain: ".qwen.ai", path: "/", expires: -1 },
  ...(withCookie
    ? [{ name: ACCOUNT_TOKEN_COOKIE_NAME, value: COOKIE_TOKEN, domain: ".qwen.ai", path: "/", expires: 1793225168 }]
    : []),
  { name: X5SEC_COOKIE_NAME, value: "clearance", domain: "chat.qwen.ai", path: "/", expires: Math.floor(Date.now() / 1000) + 900 },
];

// ── 1. both present -> localStorage wins ───────────────────────────────────

test("bearer: localStorage wins when both sources are present", async () => {
  _resetAccountSessionsForTests();
  const state = await captureAccountSessionFromPage(
    "acct-1",
    fakePage({ cookies: jar(true), lsToken: LS_TOKEN }),
  );
  assert.equal(state.bearerSource, "localStorage");
  assert.equal(state.bearerToken, LS_TOKEN);
  assert.notEqual(state.bearerToken, COOKIE_TOKEN);
});

// ── 2. cookie-only -> cookie is used ───────────────────────────────────────

test("bearer: the cookie is the fallback when localStorage has no token", async () => {
  _resetAccountSessionsForTests();
  const state = await captureAccountSessionFromPage(
    "acct-2",
    fakePage({ cookies: jar(true), lsToken: "" }),
  );
  assert.equal(state.bearerSource, "cookie");
  assert.equal(state.bearerToken, COOKIE_TOKEN);
  assert.equal(state.bearerToken.length, COOKIE_TOKEN.length);
});

// ── 3. neither -> unchanged unsupported behaviour ──────────────────────────

test("bearer: with neither source there is no token and no source", async () => {
  _resetAccountSessionsForTests();
  const state = await captureAccountSessionFromPage(
    "acct-3",
    fakePage({ cookies: jar(false), lsToken: "" }),
  );
  assert.equal(state.bearerSource, "none");
  assert.equal(state.bearerToken, "");
  // The stream factory must still refuse this rather than send an empty Bearer.
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  assert.ok(src.includes('"no-bearer-token"'), "unsupported reason preserved");
  const headers = buildDirectQwenHeaders({ cookie: "cna=x", bearerToken: state.bearerToken });
  assert.equal(headers["Authorization"], undefined, "no malformed 'Bearer ' header");
});

// ── 4. the cookie must survive untouched in the jar ───────────────────────

test("bearer: reading the cookie does not remove or alter it from the jar", async () => {
  _resetAccountSessionsForTests();
  const before = jar(true);
  const state = await captureAccountSessionFromPage(
    "acct-4",
    fakePage({ cookies: before, lsToken: "" }),
  );
  // The Cookie header sent to the upstream still carries the very same value.
  assert.ok(state.cookieHeader.includes(`${ACCOUNT_TOKEN_COOKIE_NAME}=${COOKIE_TOKEN}`));
  // …and so does the clearance, untouched.
  assert.ok(state.cookieHeader.includes(`${X5SEC_COOKIE_NAME}=clearance`));
  // The source cookie objects were not mutated.
  const tok = before.find((c) => c.name === ACCOUNT_TOKEN_COOKIE_NAME);
  assert.equal(tok?.value, COOKIE_TOKEN);
  assert.equal(before.length, 3);
});

// ── 5. the transport receives it correctly ─────────────────────────────────

test("bearer: the cookie-sourced token is sent as a real Bearer", async () => {
  _resetAccountSessionsForTests();
  const state = await captureAccountSessionFromPage(
    "acct-5",
    fakePage({ cookies: jar(true), lsToken: "" }),
  );
  const h = buildDirectQwenHeaders({
    cookie: state.cookieHeader,
    bearerToken: state.bearerToken,
    chatSessionId: "chat-1",
  });
  assert.equal(h["Authorization"], `Bearer ${COOKIE_TOKEN}`);
  // Account referer, not the guest one.
  assert.ok(h["Referer"].includes("/c/chat-1"));
});

// ── 6. no secrets in logs ──────────────────────────────────────────────────

test("bearer: capture logging never interpolates a token value", () => {
  const src = fs.readFileSync("src/services/qwen-account-session.ts", "utf-8");
  const logs = [...src.matchAll(/console\.log\(([\s\S]{0,600}?)\);/g)].map((m) => m[1]);
  assert.ok(logs.length > 0, "expected the capture log to exist");
  for (const l of logs) {
    // The sanctioned diagnostics.
    assert.ok(/bearer_source=/.test(l), "log must report the source");
    assert.ok(/bearer_present=/.test(l), "log must report presence");
    assert.ok(/bearer_length=/.test(l), "log must report length");
    // A leak would be interpolating the token ITSELF. Reading `.length` or
    // `Boolean(...)` is exactly the intended, safe usage.
    assert.ok(
      !/\$\{bearerToken\}/.test(l),
      "log interpolates the bearer token itself",
    );
    assert.ok(
      !/\$\{cookieToken\}/.test(l),
      "log interpolates the cookie token itself",
    );
    assert.ok(
      !/\$\{token\}/.test(l),
      "log interpolates a raw token",
    );
    assert.ok(!/cookieHeader/.test(l), "log must not print the jar");
    assert.ok(
      /bearerToken\.length/.test(l),
      "length must come from .length, not the value",
    );
  }
});

test("bearer: describeAccountSession still exposes no token material", async () => {
  _resetAccountSessionsForTests();
  const state = await captureAccountSessionFromPage(
    "acct-6",
    fakePage({ cookies: jar(true), lsToken: "" }),
  );
  const text = JSON.stringify(describeAccountSession(state));
  assert.ok(!text.includes(COOKIE_TOKEN), "cookie token leaked into diagnostics");
  assert.ok(!text.includes(LS_TOKEN), "localStorage token leaked");
  assert.equal(state.bearerSource, "cookie");
  assert.equal(describeAccountSession(state).bearerLen, COOKIE_TOKEN.length);
});
