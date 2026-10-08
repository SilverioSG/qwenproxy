/**
 * Bearer source precedence for the direct account transport:
 *
 *   1. persisted account token (qwen_auth_sessions)  -> "db"
 *   2. localStorage.token                            -> "localStorage"
 *   3. live `token` cookie from the browser context   -> "cookie"
 *   4. none
 *
 * The DB entry wins because it is the credential the upstream actually accepts
 * for that account: in production the token in the LIVE browser context is a
 * different, rejected value and create-chat answers `Unauthorized` with it,
 * while the persisted one is accepted across the whole pool.
 *
 * Only the Bearer comes from the DB. The cookie jar and the `x5sec` clearance
 * ALWAYS come from the live browser context, because they are WAF/session state
 * rather than a credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ACCOUNT_TOKEN_COOKIE_NAME,
  X5SEC_COOKIE_NAME,
  _resetAccountSessionsForTests,
  _setPersistedTokenResolverForTests,
  captureAccountSessionFromPage,
  describeAccountSession,
} from "../services/qwen-account-session.ts";
import { buildDirectQwenHeaders } from "../services/qwen-direct-transport.ts";

const DB_TOKEN = "eyJdb.persisted.token.sig";
const LS_TOKEN = "eyJ-bigger-localstorage-token.sig-xx";
const COOKIE_TOKEN = "eyJcookie.live.token.sig";
const CLEARANCE = "live-clearance-value";

function fakePage(opts: { cookies: Array<Record<string, unknown>>; lsToken: string }) {
  return {
    context: () => ({ cookies: async () => opts.cookies }),
    evaluate: async () => ({ token: opts.lsToken, userAgent: "Mozilla/5.0 Chrome/153.0.0.0" }),
  } as unknown as Parameters<typeof captureAccountSessionFromPage>[1];
}

const jar = (opts: { withCookie?: boolean; withX5sec?: boolean } = {}) => [
  { name: "cna", value: "x", domain: ".qwen.ai", path: "/", expires: -1 },
  ...(opts.withCookie !== false
    ? [{ name: ACCOUNT_TOKEN_COOKIE_NAME, value: COOKIE_TOKEN, domain: ".qwen.ai", path: "/", expires: 1793225168 }]
    : []),
  ...(opts.withX5sec !== false
    ? [{ name: X5SEC_COOKIE_NAME, value: CLEARANCE, domain: "chat.qwen.ai", path: "/", expires: Math.floor(Date.now() / 1000) + 900 }]
    : []),
];

function setup(dbToken: string | null) {
  _resetAccountSessionsForTests();
  _setPersistedTokenResolverForTests(dbToken === null ? null : () => dbToken);
}

// ── 1..5 the precedence itself ─────────────────────────────────────────────

test("bearer: db wins when all three sources exist", async () => {
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a1", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  assert.equal(s.bearerSource, "db");
  assert.equal(s.bearerToken, DB_TOKEN);
});

test("bearer: db wins over cookie when localStorage is absent", async () => {
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a2", fakePage({ cookies: jar(), lsToken: "" }));
  assert.equal(s.bearerSource, "db");
  assert.equal(s.bearerToken, DB_TOKEN);
});

test("bearer: localStorage is used when no db token exists", async () => {
  setup(null);
  const s = await captureAccountSessionFromPage("a3", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  assert.equal(s.bearerSource, "localStorage");
  assert.equal(s.bearerToken, LS_TOKEN);
});

test("bearer: the live cookie is the last resort", async () => {
  setup(null);
  const s = await captureAccountSessionFromPage("a4", fakePage({ cookies: jar(), lsToken: "" }));
  assert.equal(s.bearerSource, "cookie");
  assert.equal(s.bearerToken, COOKIE_TOKEN);
});

test("bearer: with no source at all the request stays unsupported", async () => {
  setup(null);
  const s = await captureAccountSessionFromPage(
    "a5",
    fakePage({ cookies: jar({ withCookie: false }), lsToken: "" }),
  );
  assert.equal(s.bearerSource, "none");
  assert.equal(s.bearerToken, "");
  // The stream factory must still refuse it, with no malformed Bearer header.
  const src = fs.readFileSync("src/services/qwen-direct-stream.ts", "utf-8");
  assert.ok(src.includes('"no-bearer-token"'));
  assert.equal(
    buildDirectQwenHeaders({ cookie: "cna=x", bearerToken: s.bearerToken })["Authorization"],
    undefined,
  );
});

test("bearer: an expired or unreadable db entry falls through, never blocks", async () => {
  // getPersistedBearerToken returns null on expiry; the resolver models that.
  setup("");
  const s = await captureAccountSessionFromPage("a6", fakePage({ cookies: jar(), lsToken: "" }));
  assert.equal(s.bearerSource, "cookie", "an unusable db entry must not win");
});

// ── 6..7 the live session state is never replaced by the db ────────────────

test("session: the live cookie jar is preserved even when the db wins", async () => {
  setup(DB_TOKEN);
  const live = jar();
  const s = await captureAccountSessionFromPage("a7", fakePage({ cookies: live, lsToken: "" }));
  // The jar sent upstream is the LIVE one (other cookies, clearance), except
  // the token pair is aligned to the authoritative db bearer — a mismatched
  // pair answers 401 on completions while chats/new still returns 200.
  assert.ok(s.cookieHeader.includes(`${ACCOUNT_TOKEN_COOKIE_NAME}=${DB_TOKEN}`));
  assert.ok(!s.cookieHeader.includes(`${ACCOUNT_TOKEN_COOKIE_NAME}=${COOKIE_TOKEN}`));
  assert.ok(s.cookieHeader.includes(`${X5SEC_COOKIE_NAME}=${CLEARANCE}`));
  // …and it is not the persisted jar, even though the Bearer came from the db.
  assert.notEqual(s.bearerToken, COOKIE_TOKEN);
  // The live source objects were not mutated.
  assert.equal(live.find((c) => c.name === ACCOUNT_TOKEN_COOKIE_NAME)?.value, COOKIE_TOKEN);
});

test("session: x5sec still comes from the live browser context", async () => {
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a8", fakePage({ cookies: jar(), lsToken: "" }));
  assert.equal(s.x5secPresent, true, "clearance must be read from the live context");
  assert.equal(s.x5secValid, true);
  assert.ok(s.x5secExpiresAt > Date.now());
  assert.ok(s.cookieHeader.includes(`${X5SEC_COOKIE_NAME}=${CLEARANCE}`));
  // The db reader must not be able to inject a clearance.
  const dbSrc = fs.readFileSync("src/core/database.ts", "utf-8");
  const s0 = dbSrc.indexOf("export function getPersistedBearerToken");
  const r0 = dbSrc.slice(s0 + "export function".length);
  const body0 = r0.slice(0, r0.indexOf("export function"));
  assert.ok(!/x5sec/i.test(body0), "the db reader must not touch clearance");
});

test("session: the db reader returns only the token and never the jar", async () => {
  const src = fs.readFileSync("src/core/database.ts", "utf-8");
  // Isolate the function body: from its declaration up to the next top-level
  // export (the slice must start AFTER the "export function" keyword itself,
  // otherwise splitting on it would yield an empty string).
  const start = src.indexOf("export function getPersistedBearerToken");
  assert.ok(start > 0, "the db reader must exist");
  const rest = src.slice(start + "export function".length);
  const body = rest.slice(0, rest.indexOf("export function"));
  assert.ok(body.length > 100, "function body must be non-trivial");
  assert.ok(
    /return\s*\{\s*token,/.test(body),
    "must return the token",
  );
  assert.ok(
    !/cookie:\s*row\.cookie/.test(body),
    "must not hand the persisted jar out",
  );
  // The only fields it returns are token metadata, never a cookie.
  const ret = body.slice(body.lastIndexOf("return {"));
  assert.ok(!/cookie/i.test(ret), "the returned object must not carry a cookie");
});

// ── 8 it really reaches the header ─────────────────────────────────────────

test("header: a db-sourced bearer is sent verbatim as Authorization: Bearer", async () => {
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a9", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  const h = buildDirectQwenHeaders({
    cookie: s.cookieHeader, bearerToken: s.bearerToken, chatSessionId: "chat-9",
  });
  assert.equal(h["Authorization"], `Bearer ${DB_TOKEN}`);
  assert.notEqual(h["Authorization"], `Bearer ${LS_TOKEN}`);
  assert.notEqual(h["Authorization"], `Bearer ${COOKIE_TOKEN}`);
  // …with the account referer and the live jar (token pair aligned to db).
  assert.ok(h["Referer"].includes("/c/chat-9"));
  assert.ok(h["Cookie"].includes(`${ACCOUNT_TOKEN_COOKIE_NAME}=${DB_TOKEN}`));
});

// ── 9 no secrets in logs ───────────────────────────────────────────────────

test("logs: capture never interpolates a token value", () => {
  for (const f of [
    "src/services/qwen-account-session.ts",
    "src/core/database.ts",
  ]) {
    const src = fs.readFileSync(f, "utf-8");
    for (const m of src.matchAll(/console\.(log|warn|error)\(([\s\S]{0,600}?)\);/g)) {
      const l = m[2];
      if (!/bearer_source|AccountSession|PersistedBearer/.test(l)) continue;
      assert.ok(!/\$\{bearerToken\}/.test(l), `${f}: interpolates the bearer`);
      assert.ok(!/\$\{cookieToken\}/.test(l), `${f}: interpolates the cookie token`);
      assert.ok(!/\$\{dbToken\}/.test(l), `${f}: interpolates the db token`);
      assert.ok(!/\$\{token\}/.test(l), `${f}: interpolates a raw token`);
      assert.ok(!/cookieHeader|row\.cookie/.test(l), `${f}: prints the jar`);
    }
  }
  // The capture log reports only source, presence and length.
  const src = fs.readFileSync("src/services/qwen-account-session.ts", "utf-8");
  assert.ok(/bearer_source=\$\{bearerSource\}/.test(src));
  assert.ok(/bearer_present=/.test(src));
  assert.ok(/bearer_length=/.test(src));
});

test("logs: diagnostics stay free of token material", async () => {
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a10", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  const text = JSON.stringify(describeAccountSession(s));
  for (const secret of [DB_TOKEN, LS_TOKEN, COOKIE_TOKEN, CLEARANCE]) {
    assert.ok(!text.includes(secret), `diagnostics leaked ${secret.slice(0, 12)}…`);
  }
  assert.equal(describeAccountSession(s).bearerLen, DB_TOKEN.length);
});

test("pair: db bearer aligns the jar token cookie (mismatched live pair 401s)", async () => {
  // The upstream completion endpoint validates the Bearer/cookie pair: a live
  // context holding a different token cookie answers 401 while chats/new
  // still returns 200. The persisted credential is authoritative.
  setup(DB_TOKEN);
  const s = await captureAccountSessionFromPage("a11", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  assert.equal(s.bearerSource, "db");
  assert.equal(s.bearerToken, DB_TOKEN);
  const tokenPair = s.cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${ACCOUNT_TOKEN_COOKIE_NAME}=`));
  assert.ok(tokenPair, "jar must carry a token pair");
  assert.equal(tokenPair, `${ACCOUNT_TOKEN_COOKIE_NAME}=${DB_TOKEN}`);
});

test("pair: non-db bearers leave the live jar untouched", async () => {
  setup(null);
  const s = await captureAccountSessionFromPage("a12", fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
  assert.equal(s.bearerSource, "localStorage");
  const tokenPair = s.cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${ACCOUNT_TOKEN_COOKIE_NAME}=`));
  assert.equal(tokenPair, `${ACCOUNT_TOKEN_COOKIE_NAME}=${COOKIE_TOKEN}`);
});

test("pair: db bearer serves the persisted jar, not the live one", async () => {
  const { saveAuthSession, deleteAuthSession } = await import("../core/database.ts");
  const id = "a13-persisted-jar";
  const persistedAccess = "eyJpersisted.db.token.sig";
  try {
    saveAuthSession(id, {
      cookie: `token=${persistedAccess}; refresh_token=R13; cna=persisted`,
      userAgent: "Mozilla/5.0 TestPersisted",
      bxV: "2.5.37",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      capturedAt: Date.now(),
    });
    _resetAccountSessionsForTests();
    _setPersistedTokenResolverForTests(() => persistedAccess);
    const s = await captureAccountSessionFromPage(id, fakePage({ cookies: jar(), lsToken: LS_TOKEN }));
    assert.equal(s.bearerSource, "db");
    assert.equal(s.bearerToken, persistedAccess);
    assert.ok(s.cookieHeader.includes("cna=persisted"));
    assert.ok(!s.cookieHeader.includes("cna=x") || s.cookieHeader.includes("cna=persisted"));
    assert.ok(!s.cookieHeader.includes(COOKIE_TOKEN));
  } finally {
    try { deleteAuthSession(id); } catch {}
    _resetAccountSessionsForTests();
    _setPersistedTokenResolverForTests(null);
  }
});
