import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  saveAuthSession,
  getValidAuthSession,
  deleteAuthSession,
  getDatabase,
  closeDatabase,
} from "../core/database.ts";

test("auth-session-persistence: saves and retrieves a valid auth session", () => {
  const db = getDatabase();
  const accountId = "test-acc-valid-1";

  deleteAuthSession(accountId);

  const now = Date.now();
  saveAuthSession(accountId, {
    cookie: "token=valid.jwt.token; other=123",
    userAgent: "Mozilla/5.0 TestChrome",
    bxV: "2.5.37",
    bxUa: "test-bx-ua-token",
    bxUmidtoken: "test-bx-umidtoken",
    secChUa: '"Chromium";v="153"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
    version: "0.2.91",
    userId: "u-12345",
    tokenExpiresAt: Math.floor(now / 1000) + 36000,
    capturedAt: now,
  });

  const session = getValidAuthSession(accountId, 4 * 60 * 60 * 1000);
  assert.ok(session !== null, "expected session to be found and valid");
  assert.equal(session?.accountId, accountId);
  assert.equal(session?.bxUa, "test-bx-ua-token");
  assert.equal(session?.bxUmidtoken, "test-bx-umidtoken");
  assert.equal(session?.bxV, "2.5.37");
  assert.equal(session?.version, "0.2.91");

  deleteAuthSession(accountId);
});

test("auth-session-persistence: rejects expired capturedAt headers", () => {
  const accountId = "test-acc-expired-capture";
  deleteAuthSession(accountId);

  const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
  saveAuthSession(accountId, {
    cookie: "token=valid.jwt.token",
    userAgent: "Mozilla/5.0 TestChrome",
    bxV: "2.5.37",
    bxUa: "test-bx-ua",
    bxUmidtoken: "test-bx-umidtoken",
    capturedAt: fiveHoursAgo,
  });

  // Requesting with 4h TTL should return null
  const session = getValidAuthSession(accountId, 4 * 60 * 60 * 1000);
  assert.equal(session, null, "expected expired capturedAt session to return null");

  deleteAuthSession(accountId);
});

test("auth-session-persistence: manual snapshot without bx-ua/bx-umidtoken stays valid (default transport)", () => {
  // Regression for manual-verify handoff: the headed snapshot comes from
  // context.cookies() which routinely lacks bx-ua/bx-umidtoken. With the
  // default transport (QWEN_SEND_BX_UA!=true) only the cookie/UA/bx-v trio
  // is sent, so the row must restore instead of forcing legacy re-auth.
  const saved = process.env.QWEN_SEND_BX_UA;
  delete process.env.QWEN_SEND_BX_UA;
  try {
    const accountId = "test-acc-manual-no-bx";
    deleteAuthSession(accountId);
    const now = Date.now();
    saveAuthSession(accountId, {
      cookie: "token=manual.jwt.token; refresh_token=rt-123; other=1",
      userAgent: "Mozilla/5.0 TestChrome",
      bxV: "2.5.37",
      bxUa: "",
      bxUmidtoken: "",
      tokenExpiresAt: Math.floor(now / 1000) + 36000,
      capturedAt: now,
      refreshToken: "rt-123",
    });
    const session = getValidAuthSession(accountId, 4 * 60 * 60 * 1000);
    assert.ok(session !== null, "expected manual snapshot without bx fields to be valid");
    assert.equal(session?.refreshToken, "rt-123");
    deleteAuthSession(accountId);
  } finally {
    if (saved === undefined) delete process.env.QWEN_SEND_BX_UA;
    else process.env.QWEN_SEND_BX_UA = saved;
  }
});

test("auth-session-persistence: empty userAgent snapshot preserves stored UA", () => {
  const accountId = "test-acc-ua-preserve";
  deleteAuthSession(accountId);
  const now = Date.now();
  saveAuthSession(accountId, {
    cookie: "token=a.jwt.token; refresh_token=R1",
    userAgent: "Mozilla/5.0 Fleet-UA",
    bxV: "2.5.37",
    bxUa: "",
    bxUmidtoken: "",
    tokenExpiresAt: Math.floor(now / 1000) + 36000,
    capturedAt: now,
    refreshToken: "R1",
  });
  // A later snapshot that failed to read the UA must not wipe it, or the row
  // stops restoring and the account falls back to legacy validation burns.
  saveAuthSession(accountId, {
    cookie: "token=a.jwt.token; refresh_token=R1",
    userAgent: "",
    bxV: "2.5.37",
    capturedAt: Date.now(),
  } as never);
  const session = getValidAuthSession(accountId, 4 * 60 * 60 * 1000);
  assert.ok(session !== null, "expected restored row to stay valid");
  assert.equal(session?.userAgent, "Mozilla/5.0 Fleet-UA");
  assert.equal(session?.refreshToken, "R1");
  deleteAuthSession(accountId);
});

test("auth-session-persistence: strict bx gate only when QWEN_SEND_BX_UA=true", () => {
  const saved = process.env.QWEN_SEND_BX_UA;
  process.env.QWEN_SEND_BX_UA = "true";
  try {
    const accountId = "test-acc-strict-bx";
    deleteAuthSession(accountId);
    const now = Date.now();
    saveAuthSession(accountId, {
      cookie: "token=manual.jwt.token",
      userAgent: "Mozilla/5.0 TestChrome",
      bxV: "2.5.37",
      bxUa: "",
      bxUmidtoken: "",
      tokenExpiresAt: Math.floor(now / 1000) + 36000,
      capturedAt: now,
    });
    assert.equal(getValidAuthSession(accountId, 4 * 60 * 60 * 1000), null);
    deleteAuthSession(accountId);
  } finally {
    if (saved === undefined) delete process.env.QWEN_SEND_BX_UA;
    else process.env.QWEN_SEND_BX_UA = saved;
  }
});

test("auth-session-persistence: rejects session with expired token", () => {
  const accountId = "test-acc-expired-token";
  deleteAuthSession(accountId);

  const now = Date.now();
  saveAuthSession(accountId, {
    cookie: "token=expired.jwt.token",
    userAgent: "Mozilla/5.0 TestChrome",
    bxV: "2.5.37",
    bxUa: "test-bx-ua",
    bxUmidtoken: "test-bx-umidtoken",
    tokenExpiresAt: Math.floor(now / 1000) - 100, // expired 100s ago
    capturedAt: now,
  });

  const session = getValidAuthSession(accountId, 4 * 60 * 60 * 1000);
  assert.equal(session, null, "expected expired token session to return null");

  deleteAuthSession(accountId);
});
