/**
 * Cold persisted session bridge (qwen-account-session):
 *
 * A cold account (no live browser page) with valid persisted modern auth must
 * yield an AccountSessionState from the persisted jar + Bearer WITHOUT opening
 * Chromium. Only when no persisted auth is usable does the existing
 * withAccountPage fallback apply (unchanged).
 *
 * No network, no browser, no production data (isolated data-test/ DB).
 * Never prints secrets: assertions compare lengths/booleans/names only, and
 * the Bearer is compared via the DB reader, never logged.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  deleteAuthSession,
  getPersistedBearerToken,
  saveAuthSession,
} from "../core/database.ts";
import {
  _resetAccountSessionsForTests,
  captureAccountSession,
  captureAccountSessionFromDb,
  cookieNames,
} from "../services/qwen-account-session.ts";
import { getAccountPageSnapshotHandles } from "../services/playwright.ts";
import {
  _resetRefreshSingleFlightForTests,
  _setRefreshFetchForTests,
} from "../services/qwen-token-refresh.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/153.0.0.0";
const X5SEC_VALUE = "cold-clearance-value-abc123";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(expSec: number): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: "u-test", exp: expSec })}.sig`;
}

function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const createdIds: string[] = [];
let idSeq = 0;

function seedCold(opts: {
  expSec?: number;
  withX5sec?: boolean;
  userAgent?: string;
}): { id: string; jar: string; access: string } {
  const id = `cold-bridge-${Date.now()}-${idSeq++}`;
  createdIds.push(id);
  const access = makeJwt(
    opts.expSec ?? Math.floor(Date.now() / 1000) + 3600,
  );
  const pairs = [`token=${access}`, "refresh_token=R-COLD-1", "cna=cold-cna"];
  if (opts.withX5sec !== false) pairs.push(`x5sec=${X5SEC_VALUE}`);
  const jar = pairs.join("; ");
  saveAuthSession(id, {
    cookie: jar,
    userAgent: opts.userAgent ?? UA,
    bxV: "2.5.37",
    bxUa: "",
    bxUmidtoken: "",
    tokenExpiresAt: opts.expSec ?? Math.floor(Date.now() / 1000) + 3600,
    capturedAt: Date.now(),
    refreshToken: "R-COLD-1",
  });
  return { id, jar, access };
}

beforeEach(() => {
  _resetAccountSessionsForTests();
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    try {
      deleteAuthSession(id);
    } catch {}
  }
  _resetAccountSessionsForTests();
  _resetRefreshSingleFlightForTests();
  _setRefreshFetchForTests(null);
});

// ── A. cold account + valid persisted auth → state, no browser ──────────────

test("A: cold persisted auth rebuilds the session without a live page", async () => {
  const { id } = seedCold({});
  assert.equal(getAccountPageSnapshotHandles(id), null);
  const state = await captureAccountSession(id);
  assert.ok(state, "expected a session from cold persisted auth");
  assert.equal(state!.accountId, id);
  assert.equal(state!.bearerSource, "db");
  assert.ok(state!.bearerToken.length > 0);
  assert.ok(state!.cookieHeader.length > 0);
  // Still no live page afterwards: no Chromium was opened to build this.
  assert.equal(getAccountPageSnapshotHandles(id), null);
});

// ── B. rotation propagates: returned bearer is the freshly persisted one ───

test("B: ensureAccountFresh rotation is reflected in the cold bearer", async () => {
  const fresh = makeJwt(Math.floor(Date.now() / 1000) + 900);
  const { id } = seedCold({
    expSec: Math.floor(Date.now() / 1000) - 3600,
  });
  let calls = 0;
  _setRefreshFetchForTests(async () => {
    calls++;
    return jsonResponse({ success: true, data: { access_token: fresh } });
  });
  const state = await captureAccountSession(id);
  assert.ok(state, "expected a session after refresh");
  assert.equal(calls, 1);
  assert.equal(state!.bearerToken, fresh);
  assert.equal(state!.bearerSource, "db");
  assert.equal(getPersistedBearerToken(id)?.token, fresh);
});

// ── C. persisted jar survives into cookieHeader ─────────────────────────────

test("C: cookieHeader carries the persisted jar (no refresh → byte-identical)", async () => {
  const { id, jar } = seedCold({});
  const state = await captureAccountSession(id);
  assert.ok(state);
  assert.equal(state!.cookieHeader, jar);
  assert.ok(state!.cookieHeader.includes("refresh_token=R-COLD-1"));
});

// ── D. persisted userAgent survives ─────────────────────────────────────────

test("D: userAgent comes from persisted material", async () => {
  const { id } = seedCold({});
  const state = await captureAccountSession(id);
  assert.ok(state);
  assert.equal(state!.userAgent, UA);
});

// ── E. x5sec metadata parsed from the persisted jar ─────────────────────────

test("E: x5sec presence + hash derive from the persisted jar", async () => {
  const { id } = seedCold({});
  const state = await captureAccountSession(id);
  assert.ok(state);
  assert.equal(state!.x5secPresent, true);
  assert.equal(state!.x5secValid, true);
  assert.equal(state!.x5secHash, hash8(X5SEC_VALUE));
  assert.equal(state!.x5secExpiresAt, 0);

  const { id: id2 } = seedCold({ withX5sec: false });
  const state2 = await captureAccountSession(id2);
  assert.ok(state2);
  assert.equal(state2!.x5secPresent, false);
  assert.equal(state2!.x5secValid, false);
  assert.equal(state2!.x5secHash, null);
});

// ── F. no usable persisted auth → null bridge, fallback preserved ───────────

test("F: unusable persisted auth yields no cold state; live fallback intact", async () => {
  const id = `cold-bridge-empty-${Date.now()}`;
  createdIds.push(id);
  assert.equal(await captureAccountSessionFromDb(id), null);
  // The withAccountPage fallback below the bridge is unchanged.
  const src = fs.readFileSync(
    "src/services/qwen-account-session.ts",
    "utf-8",
  );
  assert.ok(src.includes("withAccountPage("));
  assert.ok(src.includes("captureAccountSessionFromDb(accountId)"));
  // Diagnostics stay secret-free by construction.
  assert.ok(!cookieNames("token=abc; x5sec=def").includes("abc"));
});

test("G: dead live context falls back to the cold bridge", async () => {
  // Outcome pin: the persisted session is served even when the live path
  // cannot produce one. Structural pin: the bridge is attempted both when no
  // live page exists AND after a failed live capture (dead context).
  const { id } = seedCold({ withX5sec: false });
  const { captureAccountSession: capture } = await import(
    "../services/qwen-account-session.ts"
  );
  const state = await capture(id);
  assert.ok(state);
  assert.equal(state!.bearerSource, "db");
  const src = fs.readFileSync(
    "src/services/qwen-account-session.ts",
    "utf-8",
  );
  const liveIdx = src.indexOf("withAccountPage(");
  const lastBridgeIdx = src.lastIndexOf("captureAccountSessionFromDb(accountId)");
  assert.ok(liveIdx > 0 && lastBridgeIdx > liveIdx);
});
