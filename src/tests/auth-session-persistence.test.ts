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
